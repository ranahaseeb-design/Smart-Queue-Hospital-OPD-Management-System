import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/token.dart';
import '../models/visit.dart';
import '../navigation.dart';
import '../services/api_client.dart';
import '../services/opd_api.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/async_views.dart';
import '../widgets/info_widgets.dart';
import '../widgets/star_rating.dart';
import '../widgets/status_chip.dart';
import '../widgets/token_widgets.dart';

/// Visit & queue history with one feedback per completed visit
/// (FR-19, FR-20).
class HistoryScreen extends StatelessWidget {
  const HistoryScreen({super.key});

  Future<void> _giveFeedback(
    BuildContext context,
    Visit visit,
    ReloadCallback reload,
  ) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => FeedbackSheet(visit: visit),
    );
    if (saved == true) {
      showAppMessage('Thank you for your feedback.');
      await reload();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AsyncLoader<List<Visit>>(
      load: () => context.read<OpdApi>().visits(),
      loadingMessage: 'Loading your visits…',
      isEmpty: (list) => list.isEmpty,
      emptyBuilder: (context, reload) => const EmptyView(
        icon: Icons.history,
        title: 'No visits yet',
        message: 'Your OPD visits and tokens will appear here.',
      ),
      builder: (context, visits, reload) => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          for (final visit in visits)
            _VisitCard(
              visit: visit,
              onFeedback: visit.canGiveFeedback && visit.feedback == null
                  ? () => _giveFeedback(context, visit, reload)
                  : null,
            ),
        ],
      ),
    );
  }
}

class _VisitCard extends StatelessWidget {
  const _VisitCard({required this.visit, this.onFeedback});

  final Visit visit;
  final VoidCallback? onFeedback;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final feedback = visit.feedback;
    final comment = feedback?.comment;
    final giveFeedback = onFeedback;

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              formatApiDate(visit.visitDate),
              style: theme.textTheme.titleMedium,
            ),
            if (visit.branch != null)
              InfoLine(icon: Icons.place, text: visit.branch!.name),
            const SizedBox(height: 4),
            for (final token in visit.tokens) _VisitTokenRow(token: token),
            const Divider(height: 24),
            if (feedback != null) ...[
              Text('Your feedback', style: theme.textTheme.titleSmall),
              const SizedBox(height: 4),
              Row(
                children: [
                  StarRatingDisplay(rating: feedback.rating),
                  const SizedBox(width: 8),
                  Text(
                    ratingLabel(feedback.rating),
                    style: theme.textTheme.bodyMedium,
                  ),
                ],
              ),
              if (comment != null && comment.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text('"$comment"', style: theme.textTheme.bodyMedium),
              ],
            ] else if (giveFeedback != null)
              FilledButton.tonalIcon(
                onPressed: giveFeedback,
                icon: const Icon(Icons.star),
                label: const Text('Rate this visit'),
              )
            else
              Text(
                'Feedback can be given after a completed consultation.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _VisitTokenRow extends StatelessWidget {
  const _VisitTokenRow({required this.token});

  final VisitToken token;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final wait = token.actualWait;
    final details = <String>[
      if (token.doctorName != null && token.doctorName!.isNotEmpty)
        token.doctorName!,
      if (token.servicePointName != null && token.servicePointName!.isNotEmpty)
        token.servicePointName!,
      if (token.issuedAt != null) 'issued ${formatTime(token.issuedAt)}',
      if (wait != null && !wait.isNegative) 'waited ${wait.inMinutes} min',
    ].join(' · ');

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(
              queueTypeIcon(token.queueType),
              color: theme.colorScheme.primary,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${token.displayNumber} · ${queueTypeLabel(token.queueType)}',
                  style: theme.textTheme.titleSmall,
                ),
                if (details.isNotEmpty)
                  Text(details, style: theme.textTheme.bodyMedium),
                const SizedBox(height: 4),
                TokenStatusChip(status: token.status),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Bottom sheet for 1-5 star feedback with an optional comment (FR-20).
/// Pops with `true` once saved.
class FeedbackSheet extends StatefulWidget {
  const FeedbackSheet({super.key, required this.visit});

  final Visit visit;

  @override
  State<FeedbackSheet> createState() => _FeedbackSheetState();
}

class _FeedbackSheetState extends State<FeedbackSheet> {
  final _comment = TextEditingController();
  int _rating = 0;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_rating < 1) {
      setState(() => _error = 'Please tap a star to choose a rating.');
      return;
    }
    final api = context.read<OpdApi>();
    final navigator = Navigator.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await api.giveFeedback(widget.visit.id, _rating, _comment.text);
      // The sheet may have been dragged away meanwhile; then popping would
      // close the screen underneath.
      if (mounted) navigator.pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.isConflict
            ? 'You have already given feedback for this visit.'
            : e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = describeError(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final error = _error;
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + bottomInset),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'How was your visit?',
              textAlign: TextAlign.center,
              style: theme.textTheme.titleLarge,
            ),
            const SizedBox(height: 4),
            Text(
              [
                formatApiDate(widget.visit.visitDate),
                if (widget.visit.branch != null) widget.visit.branch!.name,
              ].join(' · '),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 12),
            StarRatingInput(
              value: _rating,
              onChanged: (v) => setState(() {
                _rating = v;
                _error = null;
              }),
            ),
            Text(
              ratingLabel(_rating),
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _comment,
              maxLength: 500,
              minLines: 2,
              maxLines: 4,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'Comment (optional)',
                hintText: 'Tell us about the waiting and the consultation',
              ),
            ),
            if (error != null) ...[
              const SizedBox(height: 8),
              InlineError(message: error),
            ],
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy ? null : _submit,
              child: _busy
                  ? const SizedBox(
                      width: 26,
                      height: 26,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    )
                  : const Text('Send feedback'),
            ),
          ],
        ),
      ),
    );
  }
}
