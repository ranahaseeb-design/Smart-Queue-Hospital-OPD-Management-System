import 'package:flutter/material.dart';

import '../utils/format.dart';

/// A waiting-time estimate shown as a range (e.g. "25–35 min") rather than a
/// single exact number, to avoid false precision (Section 4.12, FR-06).
///
/// Pure widget with no network access; covered by test/widget_test.dart.
class EstimateRangeText extends StatelessWidget {
  const EstimateRangeText({
    super.key,
    required this.low,
    required this.high,
    this.style,
    this.textAlign,
  });

  /// Builds the range from a single predicted value (doctor list,
  /// recommendations) using the contract's range formula.
  factory EstimateRangeText.fromMinutes(
    int minutes, {
    Key? key,
    TextStyle? style,
    TextAlign? textAlign,
  }) {
    final range = estimateRangeFor(minutes);
    return EstimateRangeText(
      key: key,
      low: range.low,
      high: range.high,
      style: style,
      textAlign: textAlign,
    );
  }

  final int low;
  final int high;
  final TextStyle? style;
  final TextAlign? textAlign;

  @override
  Widget build(BuildContext context) {
    final text = formatEstimateRange(low, high);
    return Semantics(
      container: true,
      label: 'Estimated wait ${text.replaceAll('–', ' to ')}',
      excludeSemantics: true,
      child: Text(text, style: style, textAlign: textAlign),
    );
  }
}
