/// Build-time configuration.
///
/// Override the backend location with
/// `flutter run --dart-define=API_URL=http://192.168.1.20:4000`.
/// The Android emulator reaches the host machine's localhost at 10.0.2.2.
class AppConfig {
  AppConfig._();

  static const String _rawApiUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: 'http://10.0.2.2:4000',
  );

  /// Backend origin without a trailing slash, e.g. `http://10.0.2.2:4000`.
  /// The REST API lives under `/api` and Socket.IO on the same origin.
  static String get apiUrl => _rawApiUrl.endsWith('/')
      ? _rawApiUrl.substring(0, _rawApiUrl.length - 1)
      : _rawApiUrl;

  /// Network timeout for every REST call.
  static const Duration requestTimeout = Duration(seconds: 15);
}
