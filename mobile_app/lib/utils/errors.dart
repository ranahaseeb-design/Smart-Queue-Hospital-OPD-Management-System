import '../services/api_client.dart';

/// Patient-friendly text for any error caught in the UI. Backend errors carry
/// a human-readable message (contract error shape); anything else gets a
/// generic sentence instead of a stack trace.
String describeError(Object error) {
  if (error is ApiException) return error.message;
  return 'Something went wrong. Please try again.';
}
