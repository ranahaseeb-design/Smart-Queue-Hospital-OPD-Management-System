import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../config.dart';

/// Error raised for any failed API call.
///
/// The backend reports errors as
/// `{ "error": { "code": "SOME_CODE", "message": "Human readable" } }`
/// (contract). Network problems use code `NETWORK_ERROR` and status 0.
class ApiException implements Exception {
  const ApiException(this.statusCode, this.code, this.message);

  const ApiException.network(String message) : this(0, 'NETWORK_ERROR', message);

  final int statusCode;
  final String code;
  final String message;

  bool get isNetwork => statusCode == 0;
  bool get isUnauthorized => statusCode == 401;
  bool get isConflict => statusCode == 409;
  bool get isNotFound => statusCode == 404;

  @override
  String toString() => message;
}

/// Thin JSON-over-HTTP client that adds the JWT and normalises errors.
class ApiClient {
  ApiClient({String? baseUrl, http.Client? httpClient})
      : baseUrl = baseUrl ?? AppConfig.apiUrl,
        _http = httpClient ?? http.Client();

  /// Backend origin, e.g. http://10.0.2.2:4000 (REST lives under /api).
  final String baseUrl;
  final http.Client _http;

  /// Current JWT; null when logged out.
  String? token;

  /// Called when an authenticated request is rejected with 401
  /// (expired/invalid JWT) so the app can return to the login screen.
  void Function()? onUnauthorized;

  Uri uri(String path, [Map<String, String?>? query]) {
    final params = <String, String>{};
    query?.forEach((key, value) {
      if (value != null && value.isNotEmpty) params[key] = value;
    });
    final base = Uri.parse('$baseUrl/api$path');
    return params.isEmpty ? base : base.replace(queryParameters: params);
  }

  Future<dynamic> get(String path, {Map<String, String?>? query}) =>
      _send('GET', path, query: query);

  Future<dynamic> post(String path, [Object? body]) =>
      _send('POST', path, body: body);

  Future<dynamic> put(String path, [Object? body]) =>
      _send('PUT', path, body: body);

  Future<dynamic> delete(String path) => _send('DELETE', path);

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, String?>? query,
    Object? body,
  }) async {
    final request = http.Request(method, uri(path, query));
    request.headers['Accept'] = 'application/json';
    final jwt = token;
    if (jwt != null) request.headers['Authorization'] = 'Bearer $jwt';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json; charset=utf-8';
      request.body = jsonEncode(body);
    }

    final response = await _execute(request);
    final decoded = _decode(response);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return decoded;
    }

    final error = _parseError(response.statusCode, decoded);
    if (error.isUnauthorized && jwt != null) {
      onUnauthorized?.call();
    }
    throw error;
  }

  Future<http.Response> _execute(http.Request request) async {
    try {
      final streamed =
          await _http.send(request).timeout(AppConfig.requestTimeout);
      return await http.Response.fromStream(streamed)
          .timeout(AppConfig.requestTimeout);
    } on TimeoutException {
      throw const ApiException.network(
          'The server is taking too long to respond. Please try again.');
    } on SocketException {
      throw const ApiException.network(
          'Cannot reach the hospital server. Check your internet connection.');
    } on http.ClientException {
      throw const ApiException.network(
          'Cannot reach the hospital server. Check your internet connection.');
    } on HandshakeException {
      throw const ApiException.network('Secure connection to the server failed.');
    }
  }

  static dynamic _decode(http.Response response) {
    if (response.bodyBytes.isEmpty) return null;
    final text = utf8.decode(response.bodyBytes, allowMalformed: true);
    try {
      return jsonDecode(text);
    } on FormatException {
      return text;
    }
  }

  static ApiException _parseError(int status, dynamic decoded) {
    String? code;
    String? message;
    if (decoded is Map) {
      final err = decoded['error'];
      if (err is Map) {
        final c = err['code'];
        final m = err['message'];
        if (c is String) code = c;
        if (m is String) message = m;
      } else if (err is String) {
        message = err;
      }
      final topMessage = decoded['message'];
      if (message == null && topMessage is String) message = topMessage;
    }
    return ApiException(
      status,
      code ?? _defaultCode(status),
      message ?? _defaultMessage(status),
    );
  }

  static String _defaultCode(int status) {
    switch (status) {
      case 400:
        return 'VALIDATION_ERROR';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 503:
        return 'AI_UNAVAILABLE';
      default:
        return 'SERVER_ERROR';
    }
  }

  static String _defaultMessage(int status) {
    switch (status) {
      case 400:
        return 'Some of the information entered is not valid.';
      case 401:
        return 'Your session has expired. Please log in again.';
      case 403:
        return 'You are not allowed to do this.';
      case 404:
        return 'The requested item was not found.';
      case 409:
        return 'This action conflicts with the current state. Please refresh.';
      default:
        return 'Something went wrong on the server (error $status).';
    }
  }

  void close() => _http.close();
}
