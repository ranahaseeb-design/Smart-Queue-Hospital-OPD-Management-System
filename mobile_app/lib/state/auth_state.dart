import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/user.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/opd_api.dart';
import '../services/socket_service.dart';

enum AuthStatus { unknown, unauthenticated, authenticated }

/// Session state (FR-01): login, registration, profile and logout.
/// Also opens/closes the real-time socket with the session.
class AuthState extends ChangeNotifier {
  AuthState({
    required ApiClient client,
    required OpdApi api,
    required AuthService storage,
    required SocketService socket,
  })  : _client = client,
        _api = api,
        _storage = storage,
        _socket = socket {
    _client.onUnauthorized = _handleUnauthorized;
  }

  final ApiClient _client;
  final OpdApi _api;
  final AuthService _storage;
  final SocketService _socket;

  AuthStatus _status = AuthStatus.unknown;
  AppUser? _user;

  /// Session generation, bumped when a session starts or is cleared. Profile
  /// requests drop their result when it changed while they were in flight,
  /// so a response for the previous patient never overwrites the new one.
  int _session = 0;

  /// Message shown on the login screen after a forced logout.
  String? sessionMessage;

  AuthStatus get status => _status;
  AppUser? get user => _user;
  bool get isAuthenticated => _status == AuthStatus.authenticated;

  /// Restores a saved session at app start.
  Future<void> bootstrap() async {
    final jwt = await _storage.loadToken();
    if (jwt == null) {
      _setStatus(AuthStatus.unauthenticated);
      return;
    }
    _client.token = jwt;
    try {
      final user = await _api.me();
      _ensurePatient(user);
      await _startSession(jwt, user);
    } on ApiException catch (e) {
      // Only a rejected/unknown session logs the patient out. When the
      // server is unreachable or failing, open with the cached profile;
      // screens show their own retry states and the socket keeps retrying.
      final sessionRejected =
          e.isUnauthorized || e.statusCode == 403 || e.isNotFound;
      if (!sessionRejected) {
        final cached = await _storage.loadCachedUser();
        if (cached != null) {
          _user = cached;
          _socket.connect(jwt);
          _setStatus(AuthStatus.authenticated);
          return;
        }
      }
      await _clearSession();
    } catch (_) {
      // Unexpected response shape or storage failure: start clean rather
      // than staying on the splash screen.
      await _clearSession();
    }
  }

  Future<void> login(String identifier, String password) async {
    final result = await _api.login(identifier, password);
    _ensurePatient(result.user);
    await _startSession(result.jwt, result.user);
  }

  Future<void> register({
    required String fullName,
    required String password,
    String? email,
    String? phone,
    String? dateOfBirth,
    String? priorityCategory,
  }) async {
    final result = await _api.register(
      fullName: fullName,
      password: password,
      email: email,
      phone: phone,
      dateOfBirth: dateOfBirth,
      priorityCategory: priorityCategory,
    );
    await _startSession(result.jwt, result.user);
  }

  Future<void> refreshProfile() async {
    final session = _session;
    final user = await _api.me();
    if (session != _session) return; // logged out / switched user meanwhile
    _user = user;
    await _storage.saveUser(user);
    notifyListeners();
  }

  Future<void> updateProfile(Map<String, dynamic> changes) async {
    final session = _session;
    final user = await _api.updateMe(changes);
    if (session != _session) return; // logged out / switched user meanwhile
    _user = user;
    await _storage.saveUser(user);
    notifyListeners();
  }

  Future<void> logout() async {
    sessionMessage = null;
    await _clearSession();
  }

  /// This app is for patients; staff/admins use the web dashboards (FR-01
  /// "route user by role").
  void _ensurePatient(AppUser user) {
    if (!user.isPatient) {
      throw const ApiException(
        403,
        'FORBIDDEN',
        'This app is for patients. Staff and administrators please use the '
            'Staff or Admin Dashboard.',
      );
    }
  }

  Future<void> _startSession(String jwt, AppUser user) async {
    _session++;
    _client.token = jwt;
    _user = user;
    sessionMessage = null;
    await _storage.saveSession(jwt, user);
    _socket.connect(jwt);
    _setStatus(AuthStatus.authenticated);
  }

  Future<void> _clearSession() async {
    _session++;
    _socket.disconnect();
    _client.token = null;
    _user = null;
    await _storage.clear();
    _setStatus(AuthStatus.unauthenticated);
  }

  void _handleUnauthorized() {
    if (_status != AuthStatus.authenticated) return;
    sessionMessage = 'Your session has expired. Please log in again.';
    unawaited(_clearSession());
  }

  void _setStatus(AuthStatus status) {
    _status = status;
    notifyListeners();
  }
}
