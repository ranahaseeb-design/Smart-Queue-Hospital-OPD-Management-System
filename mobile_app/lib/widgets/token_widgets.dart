import 'package:flutter/material.dart';

import '../models/token.dart';
import '../utils/format.dart';
import 'estimate_range_text.dart';
import 'info_widgets.dart';
import 'status_chip.dart';

IconData queueTypeIcon(String queueType) {
  switch (queueType) {
    case 'LAB':
      return Icons.science;
    case 'PHARMACY':
      return Icons.local_pharmacy;
    default:
      return Icons.medical_services;
  }
}

/// The big token card: display number first, then position, patients ahead,
/// now serving and the estimate as a range (FR-03, FR-05, FR-06; Section
/// 4.12 "the active token, position and predicted wait are always the first
/// thing shown").
class TokenHeroCard extends StatelessWidget {
  const TokenHeroCard({super.key, required this.token, this.onTap});

  final TokenDetail token;

  /// When set, the whole card opens the live token screen.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final fg = scheme.onPrimaryContainer;
    final doctor = token.doctor;
    final servicePoint = token.servicePoint;
    final estimate = token.estimate;
    final position = token.position;
    final ahead = token.patientsAhead;
    final place = <String>[
      if (token.branch != null) token.branch!.name,
      if (servicePoint != null) servicePoint.name,
    ].join(' · ');

    return Card(
      color: scheme.primaryContainer,
      elevation: 1,
      clipBehavior: Clip.antiAlias,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(20)),
      ),
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(queueTypeIcon(token.queueType), color: fg),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      queueTypeLabel(token.queueType),
                      style: theme.textTheme.titleSmall?.copyWith(color: fg),
                    ),
                  ),
                  TokenStatusChip(status: token.status),
                ],
              ),
              const SizedBox(height: 10),
              Semantics(
                label: 'Your token number is ${token.displayNumber}',
                excludeSemantics: true,
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(
                    token.displayNumber,
                    style: theme.textTheme.displayMedium?.copyWith(
                      color: fg,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1,
                    ),
                  ),
                ),
              ),
              if (token.isPriority) ...[
                const SizedBox(height: 6),
                PriorityChip(level: token.priorityLevel),
              ],
              const SizedBox(height: 8),
              if (doctor != null)
                InfoLine(
                  icon: Icons.person,
                  text: doctor.specialty.isEmpty
                      ? doctor.fullName
                      : '${doctor.fullName} · ${doctor.specialty}',
                  color: fg,
                ),
              if (place.isNotEmpty)
                InfoLine(icon: Icons.place, text: place, color: fg),
              if (token.isWaiting) ...[
                Divider(height: 28, color: fg.withAlpha(70)),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: StatBox(
                        label: 'Your position',
                        value: position == null ? '–' : '$position',
                        color: fg,
                      ),
                    ),
                    Expanded(
                      child: StatBox(
                        label: 'Patients ahead',
                        value: ahead == null ? '–' : '$ahead',
                        color: fg,
                      ),
                    ),
                    Expanded(
                      child: StatBox(
                        label: 'Now serving',
                        value: token.nowServing?.displayNumber ?? 'None yet',
                        color: fg,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Text(
                  'Estimated wait',
                  style: theme.textTheme.bodyMedium?.copyWith(color: fg),
                ),
                if (estimate != null)
                  EstimateRangeText(
                    low: estimate.low,
                    high: estimate.high,
                    style: theme.textTheme.headlineMedium?.copyWith(
                      color: fg,
                      fontWeight: FontWeight.w800,
                    ),
                  )
                else
                  Text(
                    'Calculating…',
                    style: theme.textTheme.titleLarge?.copyWith(color: fg),
                  ),
              ],
              if (token.status == TokenStatus.called) ...[
                const SizedBox(height: 16),
                TurnNotice(servicePointName: servicePoint?.name),
              ],
              if (token.status == TokenStatus.inService) ...[
                const SizedBox(height: 12),
                InfoLine(
                  icon: Icons.medical_services,
                  text: token.queueType == 'OPD'
                      ? 'You are with the doctor now.'
                      : 'You are being served now.',
                  color: fg,
                ),
              ],
              if (onTap != null) ...[
                const SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerRight,
                  child: Text(
                    'Open live view  ›',
                    style: theme.textTheme.labelLarge?.copyWith(color: fg),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Strong, high-contrast banner shown when the patient has been called.
class TurnNotice extends StatelessWidget {
  const TurnNotice({super.key, this.servicePointName});

  final String? servicePointName;

  @override
  Widget build(BuildContext context) {
    final where = servicePointName;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: const BoxDecoration(
          color: Color(0xFFB34700),
          borderRadius: BorderRadius.all(Radius.circular(14)),
        ),
        child: Row(
          children: [
            const Icon(Icons.campaign, color: Colors.white, size: 34),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                where == null
                    ? "It's your turn! Please go to the counter now."
                    : "It's your turn! Please go to $where now.",
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 19,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// FR-09: shown when the backend flags the queue as congested
/// (`congestion.suggestAlternatives`). It only offers a choice; nothing is
/// moved automatically.
class AlternativeBranchBanner extends StatelessWidget {
  const AlternativeBranchBanner({
    super.key,
    required this.onPressed,
    this.congestionLevel,
  });

  final VoidCallback onPressed;
  final String? congestionLevel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    const fg = Color(0xFF4E2100);
    final reason = switch (congestionLevel) {
      'CRITICAL' => 'This queue is very busy right now.',
      'HIGH' => 'This queue is busy right now.',
      _ => 'The expected wait in this queue is long.',
    };
    return Card(
      color: const Color(0xFFFFF3E0),
      shape: const RoundedRectangleBorder(
        side: BorderSide(color: Color(0xFFE65100), width: 1.5),
        borderRadius: BorderRadius.all(Radius.circular(16)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.alt_route, color: fg, size: 30),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'Shorter wait at another branch?',
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: fg,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              '$reason You can compare branches that offer the same '
              'specialty. Your current token stays unless you choose to '
              'switch.',
              style: theme.textTheme.bodyMedium?.copyWith(color: fg),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: onPressed,
                icon: const Icon(Icons.alt_route),
                label: const Text('See other branches'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Linked LAB / PHARMACY / transferred tokens of the same visit (FR-04).
class LinkedTokensSection extends StatelessWidget {
  const LinkedTokensSection({
    super.key,
    required this.tokens,
    this.onOpen,
    this.onViewAll,
  });

  final List<TokenDetail> tokens;
  final ValueChanged<TokenDetail>? onOpen;

  /// Opens the Linked Tokens screen with every token of the visit.
  final VoidCallback? onViewAll;

  @override
  Widget build(BuildContext context) {
    if (tokens.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final open = onOpen;
    final viewAll = onViewAll;
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
              child: Text(
                'Linked tokens (same visit)',
                style: theme.textTheme.titleMedium,
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
              child: Text(
                'Lab tests and medicines from this visit get their own '
                'token and queue.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            for (final t in tokens)
              LinkedTokenTile(
                token: t,
                onTap: open == null ? null : () => open(t),
              ),
            if (viewAll != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: TextButton.icon(
                  onPressed: viewAll,
                  icon: const Icon(Icons.list_alt),
                  label: const Text('See all tokens of this visit'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class LinkedTokenTile extends StatelessWidget {
  const LinkedTokenTile({super.key, required this.token, this.onTap});

  final TokenDetail token;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final servicePoint = token.servicePoint;
    final estimate = token.estimate;
    final waitingLine = token.isWaiting
        ? [
            if (token.position != null) 'Position ${token.position}',
            if (token.patientsAhead != null) '${token.patientsAhead} ahead',
            if (estimate != null)
              'wait ${formatEstimateRange(estimate.low, estimate.high)}',
          ].join(' · ')
        : '';
    return ListTile(
      onTap: onTap,
      leading: CircleAvatar(
        backgroundColor: theme.colorScheme.secondaryContainer,
        foregroundColor: theme.colorScheme.onSecondaryContainer,
        child: Icon(queueTypeIcon(token.queueType)),
      ),
      title: Text(
        '${token.displayNumber} · ${queueTypeLabel(token.queueType)}',
        style: theme.textTheme.titleMedium,
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (servicePoint != null)
            Text(servicePoint.name, style: theme.textTheme.bodyMedium),
          if (waitingLine.isNotEmpty)
            Text(waitingLine, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 6),
          TokenStatusChip(status: token.status),
        ],
      ),
      trailing: onTap == null ? null : const Icon(Icons.chevron_right),
    );
  }
}
