// Small, tolerant JSON readers. The backend is the source of truth for the
// shapes (docs/API_CONTRACT.md); these helpers just avoid crashes on numbers
// that arrive as strings (e.g. MySQL DECIMAL) or on missing optional keys.

typedef Json = Map<String, dynamic>;

Json asJson(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return <String, dynamic>{};
}

Json? asJsonOrNull(Object? value) {
  if (value is Map) return asJson(value);
  return null;
}

List<Json> asJsonList(Object? value) {
  if (value is List) {
    return value.whereType<Map<dynamic, dynamic>>().map(asJson).toList();
  }
  return <Json>[];
}

int? asIntOrNull(Object? value) {
  if (value == null) return null;
  if (value is int) return value;
  if (value is num) return value.round();
  if (value is String) {
    return int.tryParse(value) ?? double.tryParse(value)?.round();
  }
  if (value is bool) return value ? 1 : 0;
  return null;
}

int asInt(Object? value, [int fallback = 0]) => asIntOrNull(value) ?? fallback;

double? asDoubleOrNull(Object? value) {
  if (value == null) return null;
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value);
  return null;
}

double asDouble(Object? value, [double fallback = 0]) =>
    asDoubleOrNull(value) ?? fallback;

String? asStringOrNull(Object? value) {
  if (value == null) return null;
  if (value is String) return value;
  return value.toString();
}

String asString(Object? value, [String fallback = '']) =>
    asStringOrNull(value) ?? fallback;

bool asBool(Object? value, [bool fallback = false]) {
  if (value is bool) return value;
  if (value is num) return value != 0;
  if (value is String) {
    final v = value.toLowerCase();
    if (v == 'true' || v == '1') return true;
    if (v == 'false' || v == '0') return false;
  }
  return fallback;
}

/// Contract datetimes are hospital local time without a zone suffix
/// ("YYYY-MM-DDTHH:mm:ss"); DateTime.parse treats such strings as local.
DateTime? asDateTimeOrNull(Object? value) {
  if (value is! String || value.isEmpty) return null;
  return DateTime.tryParse(value);
}
