import 'dart:math' as math;

import 'package:intl/intl.dart';

/// Formatting helpers. Pure functions - covered by test/widget_test.dart.

/// A waiting-time range in whole minutes.
class MinuteRange {
  const MinuteRange(this.low, this.high);

  final int low;
  final int high;

  @override
  bool operator ==(Object other) =>
      other is MinuteRange && other.low == low && other.high == high;

  @override
  int get hashCode => Object.hash(low, high);

  @override
  String toString() => 'MinuteRange($low, $high)';
}

/// Range around a point estimate, exactly as the backend computes it
/// (contract): low = max(0, round(m*0.8)), high = round(m*1.2), at least
/// +/- 5 minutes. Used where the API returns only a single number
/// (doctor list, recommendations).
MinuteRange estimateRangeFor(int minutes) {
  final m = math.max(0, minutes);
  final low = math.min((m * 0.8).round(), math.max(0, m - 5));
  final high = math.max((m * 1.2).round(), m + 5);
  return MinuteRange(math.max(0, low), high);
}

String _minutesPart(int minutes) {
  if (minutes < 60) return '$minutes min';
  final h = minutes ~/ 60;
  final rem = minutes % 60;
  return rem == 0 ? '$h h' : '$h h $rem min';
}

/// Shows an estimate as a range to avoid false precision (Section 4.12),
/// e.g. "25–35 min", "50 min – 1 h 10 min", "Less than 5 min".
String formatEstimateRange(int low, int high) {
  var lo = math.max(0, low);
  var hi = math.max(0, high);
  if (lo > hi) {
    final t = lo;
    lo = hi;
    hi = t;
  }
  if (hi <= 0) return 'Any moment now';
  if (hi <= 5) return 'Less than 5 min';
  if (lo == hi) return 'About ${_minutesPart(hi)}';
  if (hi < 60) return '$lo–$hi min';
  return '${_minutesPart(lo)} – ${_minutesPart(hi)}';
}

/// Range text for a single predicted value (e.g. doctor list).
String formatEstimateMinutes(int minutes) {
  final r = estimateRangeFor(minutes);
  return formatEstimateRange(r.low, r.high);
}

String formatDistanceKm(double? km) {
  if (km == null) return 'Distance unknown';
  if (km < 1) return '${(km * 1000).round()} m away';
  return '${km.toStringAsFixed(1)} km away';
}

// ---- Dates and times (hospital local time, contract) ----

final DateFormat _dayLabel = DateFormat('EEE, d MMM yyyy');
final DateFormat _shortDay = DateFormat('EEE d MMM');
final DateFormat _time = DateFormat('h:mm a');

/// Contract date "YYYY-MM-DD" (query `?date=`, `dateOfBirth`). Built by hand
/// so it never depends on the intl default locale (digits, calendar).
String apiDate(DateTime d) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${d.year.toString().padLeft(4, '0')}-${two(d.month)}-${two(d.day)}';
}

String formatDate(DateTime? d) => d == null ? '-' : _dayLabel.format(d);

String formatShortDay(DateTime d) => _shortDay.format(d);

String formatTime(DateTime? d) => d == null ? '-' : _time.format(d);

String formatDateTime(DateTime? d) =>
    d == null ? '-' : '${_dayLabel.format(d)}, ${_time.format(d)}';

/// "YYYY-MM-DD" -> "Thu, 29 Oct 2026" (falls back to the raw text).
String formatApiDate(String? value) {
  if (value == null || value.isEmpty) return '-';
  final parsed = DateTime.tryParse(value);
  return parsed == null ? value : _dayLabel.format(parsed);
}

/// "HH:mm" -> "9:00 AM" (falls back to the raw text).
String formatHm(String value) {
  final parts = value.split(':');
  if (parts.length < 2) return value;
  final h = int.tryParse(parts[0]);
  final m = int.tryParse(parts[1]);
  if (h == null || m == null) return value;
  return _time.format(DateTime(2000, 1, 1, h, m));
}

/// Relative time for notifications: "just now", "5 min ago", or a date.
String formatRelative(DateTime? d, {DateTime? now}) {
  if (d == null) return '';
  final ref = now ?? DateTime.now();
  final diff = ref.difference(d);
  if (diff.isNegative || diff.inMinutes < 1) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes} min ago';
  if (diff.inHours < 24 && ref.day == d.day) return _time.format(d);
  return formatDateTime(d);
}

bool isSameDay(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;
