import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/appointment.dart';
import '../models/token.dart';
import '../models/user.dart';
import '../navigation.dart';
import '../services/opd_api.dart';
import '../state/auth_state.dart';
import '../state/shell_state.dart';
import '../state/token_state.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/async_views.dart';
import '../widgets/dialogs.dart';
import '../widgets/info_widgets.dart';
import '../widgets/token_widgets.dart';
import 'book_appointment_screen.dart';
import 'linked_tokens_screen.dart';
import 'recommendations_screen.dart';

/// Home: the patient's active token(s) first, live (FR-03..FR-07), or a
/// clear "Join a queue" call to action. Today's appointments can be checked
/// in from here (FR-10).
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<Appointment> _today = const [];
  int? _checkingIn;

  @override
  void initState() {
    super.initState();
    _loadTodayAppointments();
  }

  Future<void> _loadTodayAppointments() async {
    if (!mounted) return;
    final api = context.read<OpdApi>();
    try {
      final list = await api.appointments();
      if (!mounted) return;
      setState(() => _today = list.where((a) => a.canCheckIn).toList());
    } catch (_) {
      // Optional section: the Appointments tab shows full error handling.
    }
  }

  Future<void> _refresh() async {
    final tokens = context.read<TokenState>();
    await Future.wait<void>([tokens.refresh(), _loadTodayAppointments()]);
  }

  Future<void> _checkIn(Appointment appointment) async {
    final doctorName = appointment.doctor?.fullName ?? 'the doctor';
    final ok = await confirmAction(
      context,
      title: 'Check in now?',
      message: 'You will get a queue token for your '
          '${formatTime(appointment.slotStart)} appointment with $doctorName.',
      confirmLabel: 'Check in',
    );
    if (!ok || !mounted) return;
    final tokens = context.read<TokenState>();
    final shell = context.read<ShellState>();
    setState(() => _checkingIn = appointment.id);
    try {
      final token = await tokens.checkIn(appointment.id);
      showAppMessage('Checked in. Your token is ${token.displayNumber}.');
      openIssuedToken(shell, token.id);
    } catch (e) {
      showAppMessage(describeError(e), isError: true);
    } finally {
      if (mounted) setState(() => _checkingIn = null);
    }
    if (mounted) await _loadTodayAppointments();
  }

  void _openToken(TokenDetail token) => openTokenScreen(token.id);

  void _openAlternatives(TokenDetail token) {
    pushScreen<void>(
      context,
      RecommendationsScreen(
        initialSpecialty: token.doctor?.specialty,
        excludeDoctorId: token.doctor?.id,
        currentToken: token,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokenState = context.watch<TokenState>();
    final user = context.select<AuthState, AppUser?>((a) => a.user);
    final firstName = (user?.fullName ?? '').trim().split(' ').first;
    final tokens = tokenState.sortedTokens;
    final visits = tokenState.activeVisits;

    final List<Widget> tokenSection;
    if (!tokenState.loaded && tokenState.error == null) {
      tokenSection = const [
        Padding(
          padding: EdgeInsets.symmetric(vertical: 48),
          child: LoadingView(message: 'Loading your tokens…'),
        ),
      ];
    } else if (!tokenState.loaded) {
      tokenSection = [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 32),
          child: ErrorView(
            message: tokenState.error ?? 'Could not load your tokens.',
            onRetry: tokenState.refresh,
          ),
        ),
      ];
    } else if (tokens.isEmpty) {
      tokenSection = [const _JoinQueueCallToAction()];
    } else {
      tokenSection = [
        SectionTitle(
          tokens.length == 1 ? 'Your token' : 'Your tokens',
          subtitle: 'Updates live. Pull down to refresh.',
        ),
        // One group per visit, so a lab/pharmacy token linked to the
        // consultation is listed once (FR-04).
        for (final visit in visits) ...[
          for (final token in visit.tokens) ...[
            TokenHeroCard(token: token, onTap: () => _openToken(token)),
            if (token.suggestAlternatives) ...[
              const SizedBox(height: 8),
              AlternativeBranchBanner(
                congestionLevel: token.congestion?.level,
                onPressed: () => _openAlternatives(token),
              ),
            ],
            const SizedBox(height: 12),
          ],
          if (visit.linked.isNotEmpty) ...[
            LinkedTokensSection(
              tokens: visit.linked,
              onOpen: _openToken,
              onViewAll: () => pushScreen<void>(
                context,
                LinkedTokensScreen(tokenId: visit.tokens.first.id),
              ),
            ),
            const SizedBox(height: 12),
          ],
          const SizedBox(height: 8),
        ],
        if (tokenState.error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: InlineError(
              message: 'Could not refresh just now: ${tokenState.error}',
            ),
          ),
        OutlinedButton.icon(
          onPressed: () =>
              context.read<ShellState>().select(ShellState.findDoctor),
          icon: const Icon(Icons.add),
          label: const Text('Join another queue'),
        ),
      ];
    }

    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          Text(
            firstName.isEmpty ? 'Welcome' : 'Hello, $firstName',
            style: theme.textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          ...tokenSection,
          if (_today.isNotEmpty) ...[
            const SizedBox(height: 16),
            const SectionTitle(
              "Today's appointment",
              subtitle: 'Check in when you reach the hospital or are on '
                  'your way to get your queue token.',
            ),
            for (final appointment in _today)
              _CheckInCard(
                appointment: appointment,
                busy: _checkingIn == appointment.id,
                onCheckIn: () => _checkIn(appointment),
              ),
          ],
        ],
      ),
    );
  }
}

class _JoinQueueCallToAction extends StatelessWidget {
  const _JoinQueueCallToAction();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      color: theme.colorScheme.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Icon(
              Icons.confirmation_number_outlined,
              size: 56,
              color: theme.colorScheme.onSecondaryContainer,
            ),
            const SizedBox(height: 8),
            Text(
              'You have no active token',
              textAlign: TextAlign.center,
              style: theme.textTheme.titleLarge?.copyWith(
                color: theme.colorScheme.onSecondaryContainer,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              "Join a doctor's queue from home. You will see your position "
              'and expected wait live, and we will tell you when your turn '
              'is near.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyLarge?.copyWith(
                color: theme.colorScheme.onSecondaryContainer,
              ),
            ),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: () =>
                  context.read<ShellState>().select(ShellState.findDoctor),
              icon: const Icon(Icons.add_circle_outline),
              label: const Text('Join a queue'),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () =>
                  pushScreen<void>(context, const RecommendationsScreen()),
              icon: const Icon(Icons.alt_route),
              label: const Text('Find the shortest wait'),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () =>
                  pushScreen<bool>(context, const BookAppointmentScreen()),
              icon: const Icon(Icons.event_available),
              label: const Text('Book an appointment'),
            ),
          ],
        ),
      ),
    );
  }
}

class _CheckInCard extends StatelessWidget {
  const _CheckInCard({
    required this.appointment,
    required this.busy,
    required this.onCheckIn,
  });

  final Appointment appointment;
  final bool busy;
  final VoidCallback onCheckIn;

  @override
  Widget build(BuildContext context) {
    final doctor = appointment.doctor;
    final branch = appointment.branch;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            InfoLine(
              icon: Icons.schedule,
              text: formatDateTime(appointment.slotStart),
            ),
            if (doctor != null)
              InfoLine(
                icon: Icons.person,
                text: '${doctor.fullName} · ${doctor.specialty}',
              ),
            if (branch != null) InfoLine(icon: Icons.place, text: branch.name),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: busy ? null : onCheckIn,
              icon: busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    )
                  : const Icon(Icons.how_to_reg),
              label: const Text('Check in and get token'),
            ),
          ],
        ),
      ),
    );
  }
}
