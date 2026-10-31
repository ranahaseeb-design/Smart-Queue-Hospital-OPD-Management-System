import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/directory.dart';
import '../models/user.dart';
import '../navigation.dart';
import '../services/api_client.dart';
import '../state/auth_state.dart';
import '../state/shell_state.dart';
import '../state/token_state.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/estimate_range_text.dart';
import '../widgets/info_widgets.dart';

/// Join Queue confirmation (FR-03). Confirming issues a digital token and
/// opens the live token screen.
class JoinQueueScreen extends StatefulWidget {
  const JoinQueueScreen({
    super.key,
    required this.doctor,
    required this.branch,
    required this.department,
  });

  final DoctorSummary doctor;
  final Branch branch;
  final Department department;

  @override
  State<JoinQueueScreen> createState() => _JoinQueueScreenState();
}

class _JoinQueueScreenState extends State<JoinQueueScreen> {
  bool _busy = false;
  String? _error;
  bool _conflict = false;

  Future<void> _confirm() async {
    final tokens = context.read<TokenState>();
    final shell = context.read<ShellState>();
    final doctorId = widget.doctor.id;
    setState(() {
      _busy = true;
      _error = null;
      _conflict = false;
    });
    try {
      final token = await tokens.joinQueue(doctorId);
      showAppMessage('Your token ${token.displayNumber} is confirmed.');
      openIssuedToken(shell, token.id);
    } on ApiException catch (e) {
      // 409 means either "you already hold a token for this doctor today" or
      // "the doctor is not accepting patients". Offer "Go to my tokens" only
      // in the first case, checked against a fresh active-token list.
      var holdsToken = false;
      if (e.isConflict) {
        await tokens.refresh();
        holdsToken = tokens.tokens.any((t) => t.doctor?.id == doctorId);
      }
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
        _conflict = holdsToken;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = describeError(e);
      });
    }
  }

  void _goHome() {
    final shell = context.read<ShellState>();
    shell.select(ShellState.home);
    Navigator.of(context).popUntil((route) => route.isFirst);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final doctor = widget.doctor;
    final session = doctor.session;
    final wait = doctor.estimatedWaitMinutes;
    final user = context.select<AuthState, AppUser?>((a) => a.user);
    final category = user?.priorityCategory ?? PriorityCategory.none;
    final error = _error;

    return Scaffold(
      appBar: AppBar(title: const Text('Join queue')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text('Please check the details', style: theme.textTheme.titleLarge),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(doctor.fullName, style: theme.textTheme.titleLarge),
                    const SizedBox(height: 6),
                    InfoLine(
                      icon: Icons.medical_services,
                      text: widget.department.title == doctor.specialty
                          ? doctor.specialty
                          : '${widget.department.title} (${doctor.specialty})',
                    ),
                    InfoLine(icon: Icons.local_hospital, text: widget.branch.name),
                    if (doctor.servicePointName != null)
                      InfoLine(
                        icon: Icons.meeting_room,
                        text: doctor.servicePointName!,
                      ),
                    if (session != null)
                      InfoLine(
                        icon: Icons.schedule,
                        text: 'Today ${formatHm(session.startTime)} – '
                            '${formatHm(session.endTime)}',
                      ),
                    const Divider(height: 28),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: StatBox(
                            label: 'Patients in queue',
                            value: '${doctor.queueLength}',
                          ),
                        ),
                        Expanded(
                          flex: 2,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Estimated wait',
                                style: theme.textTheme.bodyMedium,
                              ),
                              const SizedBox(height: 2),
                              if (wait != null)
                                EstimateRangeText.fromMinutes(
                                  wait,
                                  style: theme.textTheme.headlineSmall
                                      ?.copyWith(fontWeight: FontWeight.w800),
                                )
                              else
                                Text(
                                  'Shown after joining',
                                  style: theme.textTheme.titleMedium,
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            if (category != PriorityCategory.none)
              Card(
                color: theme.colorScheme.secondaryContainer,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: InfoLine(
                    icon: Icons.priority_high,
                    color: theme.colorScheme.onSecondaryContainer,
                    text: 'Your token will be marked as priority '
                        '(${PriorityCategory.label(category)}). Staff may '
                        'confirm this at the counter.',
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(
                "You don't need to wait at the hospital. Your position and "
                'expected wait update live, and you will get a notification '
                'when your turn is near.',
                style: theme.textTheme.bodyLarge,
              ),
            ),
            if (error != null) ...[
              InlineError(message: error),
              const SizedBox(height: 12),
              if (_conflict) ...[
                OutlinedButton.icon(
                  onPressed: _goHome,
                  icon: const Icon(Icons.confirmation_number_outlined),
                  label: const Text('Go to my tokens'),
                ),
                const SizedBox(height: 12),
              ],
            ],
            FilledButton.icon(
              onPressed: _busy ? null : _confirm,
              icon: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    )
                  : const Icon(Icons.check_circle),
              label: const Text('Confirm and get token'),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _busy ? null : () => Navigator.of(context).pop(),
              child: const Text('Go back'),
            ),
          ],
        ),
      ),
    );
  }
}
