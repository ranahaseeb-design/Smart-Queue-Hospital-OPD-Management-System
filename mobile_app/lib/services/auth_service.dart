import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/json_utils.dart';
import '../models/user.dart';

/// Persists the JWT and the last known profile on the device so the patient
/// stays logged in between app launches (FR-01) and the app can still open
/// when the server is briefly unreachable.
class AuthService {
  static const String _jwtKey = 'smart_opd.jwt';
  static const String _userKey = 'smart_opd.user';

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  Future<String?> loadToken() async {
    final prefs = await _prefs;
    final value = prefs.getString(_jwtKey);
    return (value == null || value.isEmpty) ? null : value;
  }

  Future<AppUser?> loadCachedUser() async {
    final prefs = await _prefs;
    final raw = prefs.getString(_userKey);
    if (raw == null) return null;
    try {
      return AppUser.fromJson(asJson(jsonDecode(raw)));
    } on FormatException {
      return null;
    }
  }

  Future<void> saveSession(String jwt, AppUser user) async {
    final prefs = await _prefs;
    await prefs.setString(_jwtKey, jwt);
    await prefs.setString(_userKey, jsonEncode(user.toJson()));
  }

  Future<void> saveUser(AppUser user) async {
    final prefs = await _prefs;
    await prefs.setString(_userKey, jsonEncode(user.toJson()));
  }

  Future<void> clear() async {
    final prefs = await _prefs;
    await prefs.remove(_jwtKey);
    await prefs.remove(_userKey);
  }
}
