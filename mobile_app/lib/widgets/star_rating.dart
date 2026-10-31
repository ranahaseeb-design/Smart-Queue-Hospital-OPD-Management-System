import 'package:flutter/material.dart';

const Color _starColor = Color(0xFFB26A00);

/// Words for each rating, read out by screen readers and shown under the
/// stars so the meaning does not depend on the icons alone.
String ratingLabel(int rating) {
  switch (rating) {
    case 1:
      return 'Very poor';
    case 2:
      return 'Poor';
    case 3:
      return 'Okay';
    case 4:
      return 'Good';
    case 5:
      return 'Excellent';
    default:
      return 'Tap a star to rate';
  }
}

/// Large 1-5 star input for visit feedback (FR-20).
class StarRatingInput extends StatelessWidget {
  const StarRatingInput({
    super.key,
    required this.value,
    required this.onChanged,
    this.size = 44,
  });

  final int value;
  final ValueChanged<int> onChanged;
  final double size;

  @override
  Widget build(BuildContext context) {
    // Scales down on very narrow phones instead of overflowing.
    return FittedBox(
      fit: BoxFit.scaleDown,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 1; i <= 5; i++)
            IconButton(
              tooltip: '$i of 5 – ${ratingLabel(i)}',
              iconSize: size,
              onPressed: () => onChanged(i),
              icon: Icon(
                i <= value ? Icons.star : Icons.star_border,
                color: _starColor,
              ),
            ),
        ],
      ),
    );
  }
}

/// Read-only stars for feedback already given.
class StarRatingDisplay extends StatelessWidget {
  const StarRatingDisplay({super.key, required this.rating, this.size = 24});

  final int rating;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Rated $rating out of 5',
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 1; i <= 5; i++)
            Icon(
              i <= rating ? Icons.star : Icons.star_border,
              color: _starColor,
              size: size,
            ),
        ],
      ),
    );
  }
}
