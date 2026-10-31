import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../config.dart';
import '../models/json_utils.dart';

/// Real-time channel (FR-05, NFR-01).
///
/// The server auto-joins every socket to `user:<userId>`; screens may also
/// `subscribe` to `token:<id>`. Events only signal *that* something changed -
/// listeners re-fetch the REST resource (contract, "Real-time channel").
class SocketService {
  SocketService({String? url}) : url = url ?? AppConfig.apiUrl;

  final String url;
  io.Socket? _socket;

  /// Explicit rooms with a reference count, so two screens showing the same
  /// token do not unsubscribe each other.
  final Map<String, int> _rooms = <String, int>{};

  final StreamController<Json> _tokenUpdated =
      StreamController<Json>.broadcast();
  final StreamController<Json> _notifications =
      StreamController<Json>.broadcast();
  final StreamController<void> _connectedEvents =
      StreamController<void>.broadcast();

  /// True while the socket is connected; drives the "Live" indicator.
  final ValueNotifier<bool> connected = ValueNotifier<bool>(false);

  /// `token:updated` payloads: `{ tokenId, status }`.
  Stream<Json> get tokenUpdates => _tokenUpdated.stream;

  /// `notification` payloads: `{ id, message, tokenId }`.
  Stream<Json> get notifications => _notifications.stream;

  /// Fires on every (re)connect so screens can re-fetch anything they missed.
  Stream<void> get onConnected => _connectedEvents.stream;

  /// Opens the socket with the patient's JWT (`auth: { token }`, contract).
  void connect(String jwt) {
    _disposeSocket();
    final socket = io.io(
      url,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': jwt})
          .disableAutoConnect()
          .enableForceNew()
          .build(),
    );

    socket.onConnect((_) {
      connected.value = true;
      // Re-join explicit rooms after a (re)connect.
      for (final room in _rooms.keys) {
        socket.emit('subscribe', {'room': room});
      }
      _connectedEvents.add(null);
    });
    socket.onDisconnect((_) => connected.value = false);
    socket.onConnectError((_) => connected.value = false);

    socket.on('token:updated', (dynamic data) {
      final payload = asJsonOrNull(data);
      if (payload != null) _tokenUpdated.add(payload);
    });
    socket.on('notification', (dynamic data) {
      final payload = asJsonOrNull(data);
      if (payload != null) _notifications.add(payload);
    });

    _socket = socket;
    socket.connect();
  }

  /// Subscribe to a room such as `token:42`. Remembered across reconnects.
  void subscribe(String room) {
    final count = _rooms[room] ?? 0;
    _rooms[room] = count + 1;
    if (count > 0) return;
    final socket = _socket;
    if (socket != null && socket.connected) {
      socket.emit('subscribe', {'room': room});
    }
  }

  void unsubscribe(String room) {
    final count = _rooms[room];
    if (count == null) return;
    if (count > 1) {
      _rooms[room] = count - 1;
      return;
    }
    _rooms.remove(room);
    final socket = _socket;
    if (socket != null && socket.connected) {
      socket.emit('unsubscribe', {'room': room});
    }
  }

  /// Called on logout.
  void disconnect() {
    _rooms.clear();
    _disposeSocket();
  }

  void _disposeSocket() {
    final socket = _socket;
    _socket = null;
    if (socket != null) {
      socket.dispose();
    }
    connected.value = false;
  }
}
