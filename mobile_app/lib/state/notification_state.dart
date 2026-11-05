import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/app_notification.dart';
import '../models/json_utils.dart';
import '../services/api_client.dart';
import '../services/opd_api.dart';
import '../services/socket_service.dart';
import '../utils/errors.dart';

/// A notification that just arrived over the socket, for the in-app banner.
class IncomingNotification {
  const IncomingNotification({required this.message, this.tokenId});

  final String message;
  final int? tokenId;
}

/// In-app notifications with unread badge (FR-11).
///
/// Push via FCM is intentionally not wired in this build (see README);
/// instead the socket `notification` event delivers alerts while the app is
/// open and `GET /notifications` holds the full list.
class NotificationState extends ChangeNotifier {
  NotificationState(this._api, SocketService socket) {
    _subscriptions
      ..add(socket.notifications.listen(_onSocketNotification))
      ..add(socket.onConnected.listen((_) => unawaited(refresh())));
  }

  final OpdApi _api;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  final StreamController<IncomingNotification> _incoming =
      StreamController<IncomingNotification>.broadcast();
  bool _enabled = false;

  /// Session generation, bumped by [start] and [clear]. Requests capture it
  /// before awaiting and drop their result when it changed meanwhile, so the
  /// previous patient's notifications never land after logout/login.
  int _session = 0;

  List<AppNotification> _items = const [];
  bool _loading = false;
  bool _loaded = false;
  String? _error;

  List<AppNotification> get items => _items;
  bool get loading => _loading;
  bool get loaded => _loaded;
  String? get error => _error;
  int get unreadCount => _items.where((n) => !n.isRead).length;

  /// New alerts while the app is open (shown as a SnackBar by the shell).
  Stream<IncomingNotification> get incoming => _incoming.stream;

  void start() {
    _session++;
    _enabled = true;
    unawaited(refresh());
  }

  void clear() {
    _session++;
    _enabled = false;
    _items = const [];
    _loaded = false;
    _loading = false;
    _error = null;
    notifyListeners();
  }

  Future<void> refresh() async {
    if (!_enabled) return;
    final session = _session;
    _loading = true;
    notifyListeners();
    try {
      final items = await _api.notifications();
      if (session != _session) return; // stale: logout/login meanwhile
      _items = items;
      _loaded = true;
      _error = null;
    } on ApiException catch (e) {
      if (session != _session) return;
      _error = e.message;
    } catch (e) {
      if (session != _session) return;
      _error = describeError(e);
    } finally {
      // After clear()/start() the newer session owns the loading flag.
      if (session == _session) {
        _loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> markAllRead() async {
    if (unreadCount == 0) return;
    final session = _session;
    // Optimistic: clear the badge immediately.
    final previous = _items;
    _items = _items.map((n) => n.copyWith(isRead: true)).toList();
    notifyListeners();
    try {
      await _api.markAllNotificationsRead();
    } catch (_) {
      // Never restore the previous session's list after logout/login.
      if (session != _session) return;
      // Restore the badge; the patient can try again.
      _items = previous;
      notifyListeners();
      rethrow;
    }
  }

  void _onSocketNotification(Json payload) {
    if (!_enabled) return;
    final message = asString(payload['message']);
    if (message.isNotEmpty) {
      _incoming.add(IncomingNotification(
        message: message,
        tokenId: asIntOrNull(payload['tokenId']),
      ));
    }
    unawaited(refresh());
  }

  @override
  void dispose() {
    for (final s in _subscriptions) {
      s.cancel();
    }
    _incoming.close();
    super.dispose();
  }
}
