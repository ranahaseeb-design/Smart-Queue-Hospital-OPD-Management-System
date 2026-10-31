import 'package:flutter/material.dart';

import '../models/user.dart';

/// Picker for the patient's priority category (FR-01, FR-13), with a plain
/// explanation of what it means. Built from list tiles rather than radio
/// buttons so each option is a large touch target.
class PriorityCategoryPicker extends StatelessWidget {
  const PriorityCategoryPicker({
    super.key,
    required this.value,
    required this.onChanged,
  });

  final String value;
  final ValueChanged<String> onChanged;

  static IconData _icon(String category) {
    switch (category) {
      case PriorityCategory.elderly:
        return Icons.elderly;
      case PriorityCategory.differentlyAbled:
        return Icons.accessible;
      default:
        return Icons.person;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Priority category (optional)', style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(
          PriorityCategory.explanation,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: scheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 8),
        for (final category in PriorityCategory.values)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Material(
              color: category == value
                  ? scheme.primaryContainer
                  : scheme.surface,
              shape: RoundedRectangleBorder(
                side: BorderSide(
                  color: category == value ? scheme.primary : scheme.outline,
                  width: category == value ? 2 : 1,
                ),
                borderRadius: const BorderRadius.all(Radius.circular(12)),
              ),
              clipBehavior: Clip.antiAlias,
              child: ListTile(
                selected: category == value,
                leading: Icon(_icon(category)),
                title: Text(PriorityCategory.label(category)),
                trailing: Icon(
                  category == value
                      ? Icons.radio_button_checked
                      : Icons.radio_button_unchecked,
                  color: category == value ? scheme.primary : scheme.outline,
                ),
                onTap: () => onChanged(category),
              ),
            ),
          ),
      ],
    );
  }
}
