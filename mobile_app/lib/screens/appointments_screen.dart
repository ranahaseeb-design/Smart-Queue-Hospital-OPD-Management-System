import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/appointment.dart';
import '../navigation.dart';
import '../services/opd_api.dart';
import '../state/shell_state.dart';
import '../state/token_state.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/async_views.dart';
import '../widgets/dialogs.dart';
import '../widgets/info_widgets.dart';
import '../widgets/status_chip.dart';
import 'book_appointment_screen.dart';

/// Appointments (FR-10): list, book, reschedule, cancel and check in on the
/// appointment day (check-in issues a queue token).
class AppointmentsScreen extends StatefulWidget {
  const AppointmentsScreen({super.key});

  @override
  State<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends State<AppointmentsScreen> {
  /// Changing the key restarts the loader (after booking from a new route).
  Key _loaderKey = UniqueKey();
  int? _busyId;

  void _reloadAll() => setState(() => _loaderKey = UniqueKey());

  Future<void> _book() async {
    final changed =
        await pushScreen<bool>(context, const BookAppointmentScreen());
    if (changed == true && mounted) _reloadAll();
  }

  Future<void> _reschedule(Appointment appointment, ReloadCallback reload) async {
    final changed = await pushScreen<bool>(
      context,
      BookAppointmentScreen(reschedule: appointment),
    );
    if (changed == true && mounted) await reload();
  }

  Future<void> _cancel(Appointment appointment, ReloadCallback reload) async {
    final ok = await confirmAction(
      context,
      title: 'Cancel this appointment?',
      message: 'Your ${formatDateTime(appointment.slotStart)} appointment '
          'with ${appointment.doctor?.fullName ?? 'the doctor'} will be '
          'cancelled and the time given to someone else.',
      confirmLabel: 'Yes, cancel it',
      cancelLabel: 'Keep appointment',
      destructive: true,
    );
    if (!ok || !mounted) return;
    final api = context.read<OpdApi>();
    setState(() => _busyId = appointment.id);
    try {
      await api.cancelAppointment(appointment.id);
      showAppMessage('Appointment cancelled.');
    } catch (e) {
      showAppMessage(describeError(e), isError: true);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
    if (mounted) await reload();
  }

  Future<void> _checkIn(Appointment appointment) async {
    final ok = await confirmAction(
      context,
      title: 'Check in now?',
      message: 'You will get a queue token for your '
          '${formatTime(appointment.slotStart)} appointment.',
      confirmLabel: 'Check in',
    );
    if (!ok || !mounted) return;
    final tokens = context.read<TokenState>();
    final shell = context.read<ShellState>();
    setState(() => _busyId = appointment.id);
    try {
      final token = await tokens.checkIn(appointment.id);
      showAppMessage('Checked in. Your token is ${token.displayNumber}.');
      openIssuedToken(shell, token.id);
    } catch (e) {
      showAppMessage(describeError(e), isError: true);
      if (mounted) setState(() => _busyId = null);
    }
  }

  /// Booked or checked-in appointments from today onwards.
  static bool _isUpcoming(Appointment a) {
    if (a.status != AppointmentStatus.booked &&
        a.status != AppointmentStatus.checkedIn) {
      return false;
    }
    final slot = a.slotStart;
    if (slot == null) return true;
    final now = DateTime.now();
    return !slot.isBefore(DateTime(now.year, now.month, now.day));
  }

  @override
  Widget build(BuildContext context) {
    return AsyncLoader<List<Appointment>>(
      key: _loaderKey,
      load: () => context.read<OpdApi>().appointments(),
      loadingMessage: 'Loading your appointments…',
      isEmpty: (list) => list.isEmpty,
      emptyBuilder: (context, reload) => EmptyView(
        icon: Icons.event_available,
        title: 'No appointments yet',
        message: 'Book a time with a doctor in advance and check in on the '
            'day to get your token.',
        action: FilledButton.icon(
          onPressed: _book,
          icon: const Icon(Icons.add),
          label: const Text('Book an appointment'),
        ),
      ),
      builder: (context, appointments, reload) {
        final upcoming = appointments.where(_isUpcoming).toList()
          ..sort((a, b) {
            final sa = a.slotStart;
            final sb = b.slotStart;
            if (sa == null || sb == null) return 0;
            return sa.compareTo(sb);
          });
        final past = appointments.where((a) => !_isUpcoming(a)).toList();
        return ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            FilledButton.icon(
              onPressed: _book,
              icon: const Icon(Icons.add),
              label: const Text('Book an appointment'),
            ),
            const SizedBox(height: 8),
            SectionTitle(
              'Upcoming',
              subtitle: upcoming.isEmpty ? 'No upcoming appointments.' : null,
            ),
            for (final a in upcoming)
              _AppointmentCard(
                appointment: a,
                busy: _busyId == a.id,
                onCheckIn: a.canCheckIn ? () => _checkIn(a) : null,
                onReschedule:
                    a.isBooked ? () => _reschedule(a, reload) : null,
                onCancel: a.isBooked ? () => _cancel(a, reload) : null,
              ),
            if (past.isNotEmpty) ...[
              const SizedBox(height: 8),
              const SectionTitle('Past and cancelled'),
              for (final a in past) _AppointmentCard(appointment: a),
            ],
          ],
        );
      },
    );
  }
}

class _AppointmentCard extends StatelessWidget {
  const _AppointmentCard({
    required this.appointment,
    this.busy = false,
    this.onCheckIn,
    this.onReschedule,
    this.onCancel,
  });

  final Appointment appointment;
  final bool busy;
  final VoidCallback? onCheckIn;
  final VoidCallback? onReschedule;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final doctor = appointment.doctor;
    final branch = appointment.branch;
    final tokenId = appointment.tokenId;
    final checkIn = onCheckIn;
    final reschedule = onReschedule;
    final cancel = onCancel;

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    formatDateTime(appointment.slotStart),
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                const SizedBox(width: 8),
                AppointmentStatusChip(status: appointment.status),
              ],
            ),
            const SizedBox(height: 8),
            if (doctor != null)
              InfoLine(
                icon: Icons.person,
                text: '${doctor.fullName} · ${doctor.specialty}',
              ),
            if (branch != null) InfoLine(icon: Icons.place, text: branch.name),
            if (busy) ...[
              const SizedBox(height: 12),
              const LinearProgressIndicator(),
            ],
            if (checkIn != null) ...[
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: busy ? null : checkIn,
                icon: const Icon(Icons.how_to_reg),
                label: const Text('Check in and get token'),
              ),
            ],
            if (tokenId != null &&
                appointment.status == AppointmentStatus.checkedIn) ...[
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: () => openTokenScreen(tokenId),
                icon: const Icon(Icons.confirmation_number_outlined),
                label: const Text('View my token'),
              ),
            ],
            if (reschedule != null || cancel != null) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  if (reschedule != null)
                    Expanded(
                      child: OutlinedButton(
                        onPressed: busy ? null : reschedule,
                        child: const Text('Reschedule'),
                      ),
                    ),
                  if (reschedule != null && cancel != null)
                    const SizedBox(width: 12),
                  if (cancel != null)
                    Expanded(
                      child: TextButton(
                        style: TextButton.styleFrom(
                          foregroundColor: theme.colorScheme.error,
                          minimumSize: const Size(48, 56),
                        ),
                        onPressed: busy ? null : cancel,
                        child: const Text('Cancel'),
                      ),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
