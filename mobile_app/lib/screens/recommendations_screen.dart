import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/recommendation.dart';
import '../models/token.dart';
import '../navigation.dart';
import '../services/api_client.dart';
import '../services/location_service.dart';
import '../services/opd_api.dart';
import '../state/shell_state.dart';
import '../state/token_state.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/async_views.dart';
import '../widgets/dialogs.dart';
import '../widgets/estimate_range_text.dart';
import '../widgets/info_widgets.dart';
import '../widgets/status_chip.dart';

/// Smart branch recommendation (FR-08) and the alternative-branch prompt on
/// congestion (FR-09).
///
/// Branches offering the chosen specialty are ranked by the backend
/// (Eq. 6.3: weighted predicted wait, distance and congestion). Location is
/// optional: it is asked for only here, after an explanation, used once for
/// the query and never stored (NFR-05). When opened from a congested token,
/// the patient decides whether to switch; nothing moves automatically.
class RecommendationsScreen extends StatefulWidget {
  const RecommendationsScreen({
    super.key,
    this.initialSpecialty,
    this.excludeDoctorId,
    this.currentToken,
  });

  final String? initialSpecialty;

  /// The doctor the patient is already queued with (FR-09).
  final int? excludeDoctorId;

  /// The congested token the patient may switch from (FR-09).
  final TokenDetail? currentToken;

  @override
  State<RecommendationsScreen> createState() => _RecommendationsScreenState();
}

class _RecommendationsScreenState extends State<RecommendationsScreen> {
  late final OpdApi _api;

  List<String>? _specialties;
  String? _specialtiesError;
  String? _specialty;

  RecommendationResult? _result;
  bool _loading = false;
  String? _error;

  LocationResult? _location;
  bool _locating = false;

  int? _joiningDoctorId;

  @override
  void initState() {
    super.initState();
    _api = context.read<OpdApi>();
    final initial = widget.initialSpecialty;
    if (initial != null && initial.isNotEmpty) {
      _specialty = initial;
      _loading = true;
      // Fetch after the first frame (works without location, FR-08).
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _fetch();
      });
    }
    _loadSpecialties();
  }

  Future<void> _loadSpecialties() async {
    try {
      final list = await _api.specialties();
      if (!mounted) return;
      setState(() {
        _specialties = list;
        _specialtiesError = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _specialtiesError = describeError(e));
    }
  }

  Future<void> _fetch() async {
    final specialty = _specialty;
    if (specialty == null) return;
    final location = _location;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await _api.recommendations(
        specialty: specialty,
        latitude: location?.latitude,
        longitude: location?.longitude,
        excludeDoctorId: widget.excludeDoctorId,
      );
      if (!mounted || specialty != _specialty) return;
      setState(() {
        _result = result;
        _loading = false;
      });
    } catch (e) {
      if (!mounted || specialty != _specialty) return;
      setState(() {
        _error = describeError(e);
        _loading = false;
      });
    }
  }

  void _selectSpecialty(String specialty) {
    if (specialty == _specialty) return;
    setState(() {
      _specialty = specialty;
      _result = null;
    });
    _fetch();
  }

  Future<void> _useLocation() async {
    final locationService = context.read<LocationService>();
    setState(() => _locating = true);
    final result = await locationService.currentLocation();
    if (!mounted) return;
    setState(() {
      _location = result;
      _locating = false;
    });
    if (result.hasLocation) await _fetch();
  }

  void _stopUsingLocation() {
    setState(() => _location = null);
    _fetch();
  }

  Future<void> _join(RecommendationItem item) async {
    final current = widget.currentToken;
    // Only a still-waiting token can be swapped for a new one.
    final switchFrom = (current != null && current.canCancel) ? current : null;
    final range = formatEstimateMinutes(item.predictedWaitMinutes);

    final ok = await confirmAction(
      context,
      title: switchFrom != null
          ? 'Switch to ${item.branchName}?'
          : 'Join the queue at ${item.branchName}?',
      message: switchFrom != null
          ? 'You will get a new token for ${item.doctorName} '
              '(estimated wait $range). Your current token '
              '${switchFrom.displayNumber} will then be cancelled.'
          : 'You will get a token for ${item.doctorName}. Estimated wait: '
              '$range.',
      confirmLabel: switchFrom != null ? 'Yes, switch' : 'Join queue',
      cancelLabel:
          switchFrom != null ? 'Keep my current token' : 'Not now',
    );
    if (!ok || !mounted) return;

    final tokens = context.read<TokenState>();
    final shell = context.read<ShellState>();
    setState(() => _joiningDoctorId = item.doctorId);
    try {
      final token = await tokens.joinQueue(item.doctorId);
      var message =
          'Your token ${token.displayNumber} at ${item.branchName} is '
          'confirmed.';
      if (switchFrom != null) {
        try {
          await tokens.cancel(switchFrom.id);
          message = '$message Your old token ${switchFrom.displayNumber} '
              'was cancelled.';
        } on ApiException catch (e) {
          message = '$message Your old token ${switchFrom.displayNumber} '
              'could not be cancelled (${e.message}). You can cancel it '
              'from the Home screen.';
        }
      }
      showAppMessage(message);
      openIssuedToken(shell, token.id);
    } catch (e) {
      if (mounted) setState(() => _joiningDoctorId = null);
      showAppMessage(describeError(e), isError: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Shortest wait')),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async {
            if (_specialties == null) await _loadSpecialties();
            await _fetch();
          },
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: [
              if (widget.currentToken != null) ...[
                _CurrentTokenNote(token: widget.currentToken!),
                const SizedBox(height: 12),
              ],
              const SectionTitle(
                'Which specialty do you need?',
                subtitle: 'We compare every branch that offers it.',
              ),
              _buildSpecialtyPicker(context),
              const SizedBox(height: 16),
              _buildLocationCard(context),
              const SizedBox(height: 16),
              ..._buildResults(context),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSpecialtyPicker(BuildContext context) {
    final specialties = _specialties;
    final selected = _specialty;
    if (specialties == null) {
      final error = _specialtiesError;
      if (error != null) {
        return ErrorView(message: error, onRetry: _loadSpecialties);
      }
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    // Keep a specialty passed in from a token even if the list differs.
    final options = <String>[
      ...specialties,
      if (selected != null && !specialties.contains(selected)) selected,
    ];
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final s in options)
          ChoiceChip(
            label: Text(s, style: const TextStyle(fontSize: 16)),
            avatar: Icon(specialtyIcon(s), size: 20),
            selected: s == selected,
            onSelected: (_) => _selectSpecialty(s),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          ),
      ],
    );
  }

  Widget _buildLocationCard(BuildContext context) {
    final theme = Theme.of(context);
    final location = _location;

    if (location != null && location.hasLocation) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
          child: Row(
            children: [
              Icon(Icons.location_on, color: theme.colorScheme.primary),
              const SizedBox(width: 10),
              const Expanded(
                child: Text('Distance from your current location is included.'),
              ),
              TextButton(
                onPressed: _stopUsingLocation,
                child: const Text('Stop'),
              ),
            ],
          ),
        ),
      );
    }

    return Card(
      color: theme.colorScheme.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(
                  Icons.near_me,
                  color: theme.colorScheme.onSecondaryContainer,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Include distance? (optional)',
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: theme.colorScheme.onSecondaryContainer,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              'If you allow it, we use your location once to work out how far '
              'each branch is. It is not saved. Without it, branches are '
              'ranked by waiting time and how busy they are.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSecondaryContainer,
              ),
            ),
            if (location != null && location.problem != null) ...[
              const SizedBox(height: 8),
              Text(
                location.problem!,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSecondaryContainer,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
            const SizedBox(height: 12),
            if (location != null && location.blocked)
              OutlinedButton.icon(
                onPressed: () => context.read<LocationService>().openSettings(),
                icon: const Icon(Icons.settings),
                label: const Text('Open phone settings'),
              )
            else
              FilledButton.tonalIcon(
                onPressed: _locating ? null : _useLocation,
                icon: _locating
                    ? const SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(strokeWidth: 3),
                      )
                    : const Icon(Icons.my_location),
                label: Text(
                  location == null ? 'Use my location' : 'Try again',
                ),
              ),
          ],
        ),
      ),
    );
  }

  List<Widget> _buildResults(BuildContext context) {
    final theme = Theme.of(context);
    final specialty = _specialty;
    final result = _result;
    final error = _error;

    if (specialty == null) {
      return [
        Text(
          'Choose a specialty above to see the best branches.',
          style: theme.textTheme.bodyLarge,
        ),
      ];
    }
    if (result == null) {
      if (error != null) {
        return [ErrorView(message: error, onRetry: _fetch)];
      }
      return const [
        Padding(
          padding: EdgeInsets.symmetric(vertical: 32),
          child: LoadingView(message: 'Comparing branches…'),
        ),
      ];
    }

    // The ranking may include a doctor the patient already queues with (the
    // backend cannot join twice: 409). Such a card offers "View my token".
    final activeTokens = context.watch<TokenState>().tokens;
    TokenDetail? heldWith(int doctorId) {
      for (final t in activeTokens) {
        if (t.doctor?.id == doctorId) return t;
      }
      return null;
    }

    final weights = result.weights;
    final usesDistance = _location?.hasLocation ?? false;
    final basis = usesDistance
        ? 'Ranked by predicted wait (${_pct(weights.wait)}), distance '
            '(${_pct(weights.distance)}) and congestion '
            '(${_pct(weights.congestion)}).'
        : 'Ranked by predicted wait and congestion (no location used).';

    return [
      SectionTitle('Best options for $specialty', subtitle: basis),
      if (_loading) const LinearProgressIndicator(),
      if (error != null) ...[
        InlineError(message: error),
        const SizedBox(height: 8),
      ],
      if (result.items.isEmpty)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 24),
          child: EmptyView(
            icon: Icons.search_off,
            title: 'No other branch available',
            message: 'No branch has a doctor of this specialty accepting '
                'patients right now. Please try again later.',
          ),
        ),
      for (var i = 0; i < result.items.length; i++) ...[
        _RecommendationCard(
          item: result.items[i],
          heldToken: heldWith(result.items[i].doctorId),
          isBest: i == 0,
          joining: _joiningDoctorId == result.items[i].doctorId,
          enabled: _joiningDoctorId == null,
          onJoin: () => _join(result.items[i]),
        ),
        const SizedBox(height: 12),
      ],
    ];
  }

  static String _pct(double weight) => '${(weight * 100).round()}%';
}

class _CurrentTokenNote extends StatelessWidget {
  const _CurrentTokenNote({required this.token});

  final TokenDetail token;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final estimate = token.estimate;
    final where = token.branch?.name ?? 'your branch';
    final wait = estimate == null
        ? ''
        : ' Estimated wait there: '
            '${formatEstimateRange(estimate.low, estimate.high)}.';
    return Card(
      color: theme.colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: InfoLine(
          icon: Icons.confirmation_number_outlined,
          color: theme.colorScheme.onPrimaryContainer,
          text: 'You hold token ${token.displayNumber} at $where.$wait '
              'Nothing changes unless you choose to switch.',
        ),
      ),
    );
  }
}

class _RecommendationCard extends StatelessWidget {
  const _RecommendationCard({
    required this.item,
    required this.isBest,
    required this.joining,
    required this.enabled,
    required this.onJoin,
    this.heldToken,
  });

  final RecommendationItem item;

  /// The patient's active token with this doctor, if any.
  final TokenDetail? heldToken;
  final bool isBest;
  final bool joining;
  final bool enabled;
  final VoidCallback onJoin;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final address = item.address;
    final held = heldToken;
    return Card(
      shape: RoundedRectangleBorder(
        side: isBest
            ? BorderSide(color: scheme.primary, width: 2)
            : BorderSide.none,
        borderRadius: const BorderRadius.all(Radius.circular(16)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (isBest) ...[
              StatusChip(
                style: ChipStyle(
                  'Best choice',
                  Icons.thumb_up,
                  scheme.primaryContainer,
                  scheme.onPrimaryContainer,
                ),
              ),
              const SizedBox(height: 8),
            ],
            Text(item.branchName, style: theme.textTheme.titleLarge),
            if (address != null && address.isNotEmpty)
              Text(address, style: theme.textTheme.bodyMedium),
            const SizedBox(height: 6),
            InfoLine(icon: Icons.person, text: item.doctorName),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Predicted wait', style: theme.textTheme.bodyMedium),
                      EstimateRangeText.fromMinutes(
                        item.predictedWaitMinutes,
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Distance', style: theme.textTheme.bodyMedium),
                      Text(
                        item.distanceKm == null
                            ? 'Not used'
                            : formatDistanceKm(item.distanceKm),
                        style: theme.textTheme.titleMedium,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            CongestionChip(level: item.congestionLevel),
            if (item.reason.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                item.reason,
                style: theme.textTheme.bodyLarge?.copyWith(
                  fontStyle: FontStyle.italic,
                ),
              ),
            ],
            const SizedBox(height: 12),
            if (held != null) ...[
              InfoLine(
                icon: Icons.confirmation_number_outlined,
                text: 'You already hold token ${held.displayNumber} with '
                    'this doctor.',
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () => openTokenScreen(held.id),
                  icon: const Icon(Icons.confirmation_number_outlined),
                  label: const Text('View my token'),
                ),
              ),
            ] else
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: enabled ? onJoin : null,
                  icon: joining
                      ? const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(strokeWidth: 3),
                        )
                      : const Icon(Icons.add_circle_outline),
                  label: const Text('Join here'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
