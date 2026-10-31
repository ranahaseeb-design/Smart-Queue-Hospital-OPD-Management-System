import 'dart:async';

// ValueListenable is not re-exported by material.dart.
import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/json_utils.dart';
import '../models/token.dart';
import '../navigation.dart';
import '../services/opd_api.dart';
import '../services/socket_service.dart';
import '../state/shell_state.dart';
import '../state/token_state.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/async_views.dart';
import '../widgets/dialogs.dart';
import '../widgets/info_widgets.dart';
import '../widgets/token_widgets.dart';
import 'linked_tokens_screen.dart';
import 'recommendations_screen.dart';

/// My Token (live) - FR-05, FR-06, FR-07, FR-09, FR-04.
///
/// Subscribes to the `token:<id>` socket room and re-fetches
/// `GET /tokens/:id` whenever `token:updated` arrives (for this token, one of
/// its linked tokens or a newly issued linked token), so position, now
/// serving and the estimate move on their own (NFR-01). Falls back to polling
/// while the socket is down.
class TokenScreen extends StatefulWidget {
  const TokenScreen({super.key, required this.tokenId});

  final int tokenId;

  @override
  State<TokenScreen> createState() => _TokenScreenState();
}

class _TokenScreenState extends State<TokenScreen> {
  late final OpdApi _api;
  late final SocketService _socket;
  late final String _room;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  Timer? _debounce;
  Timer? _poll;

  TokenDetail? _token;
  String? _error;
  bool _cancelling = false;

  @override
  void initState() {
    super.initState();
    _api = context.read<OpdApi>();
    _socket = context.read<SocketService>();
    _room = 'token:${widget.tokenId}';
    _socket.subscribe(_room);
    _subscriptions
      ..add(_socket.tokenUpdates.listen(_onTokenUpdated))
      ..add(_socket.onConnected.listen((_) => _scheduleReload()));
    // Safety net when the real-time channel is unavailable.
    _poll = Timer.periodic(const Duration(seconds: 45), (_) {
      if (!_socket.connected.value) _load();
    });
    _load();
  }

  @override
  void dispose() {
    _socket.unsubscribe(_room);
    for (final s in _subscriptions) {
      s.cancel();
    }
    _debounce?.cancel();
    _poll?.cancel();
    super.dispose();
  }

  /// `token:updated` (`{ tokenId, status }`) only reaches this socket for the
  /// patient's own tokens (`user:<id>`) and for the `token:<id>` room joined
  /// above. Every such event re-fetches (debounced): besides this token and
  /// its known linked tokens, an event for an id not seen yet is usually the
  /// LAB / PHARMACY token that staff just issued for this visit (FR-04), which
  /// would otherwise only appear here after a manual refresh.
  void _onTokenUpdated(Json payload) => _scheduleReload();

  void _scheduleReload() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), _load);
  }

  Future<void> _load() async {
    try {
      final token = await _api.token(widget.tokenId);
      if (!mounted) return;
      setState(() {
        _token = token;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = describeError(e));
    }
  }

  Future<void> _cancel(TokenDetail token) async {
    final ok = await confirmAction(
      context,
      title: 'Cancel token ${token.displayNumber}?',
      message: 'You will lose your place in this queue. This cannot be '
          'undone.',
      confirmLabel: 'Yes, cancel token',
      cancelLabel: 'Keep my token',
      destructive: true,
    );
    if (!ok || !mounted) return;
    final tokens = context.read<TokenState>();
    setState(() => _cancelling = true);
    try {
      final updated = await tokens.cancel(token.id);
      showAppMessage('Token ${updated.displayNumber} has been cancelled.');
      if (!mounted) return;
      setState(() => _token = updated);
      await _load();
    } catch (e) {
      showAppMessage(describeError(e), isError: true);
    } finally {
      if (mounted) setState(() => _cancelling = false);
    }
  }

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

  void _backToHome() {
    context.read<ShellState>().select(ShellState.home);
    Navigator.of(context).popUntil((route) => route.isFirst);
  }

  @override
  Widget build(BuildContext context) {
    final token = _token;
    return Scaffold(
      appBar: AppBar(
        title: Text(token == null ? 'My token' : 'Token ${token.displayNumber}'),
        actions: [
          _LiveIndicator(connected: _socket.connected),
          const SizedBox(width: 12),
        ],
      ),
      body: SafeArea(child: _buildBody(context, token)),
    );
  }

  Widget _buildBody(BuildContext context, TokenDetail? token) {
    if (token == null) {
      final error = _error;
      if (error == null) {
        return const LoadingView(message: 'Loading your token…');
      }
      return RefreshIndicator(
        onRefresh: _load,
        child: ScrollableFill(child: ErrorView(message: error, onRetry: _load)),
      );
    }

    final theme = Theme.of(context);
    final doctor = token.doctor;
    final estimate = token.estimate;
    final issuedAt = token.issuedAt;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          if (_error != null) ...[
            InlineError(message: 'Showing last known status. $_error'),
            const SizedBox(height: 12),
          ],
          TokenHeroCard(token: token),
          if (token.suggestAlternatives) ...[
            const SizedBox(height: 12),
            AlternativeBranchBanner(
              congestionLevel: token.congestion?.level,
              onPressed: () => _openAlternatives(token),
            ),
          ],
          if (token.linkedTokens.isNotEmpty) ...[
            const SizedBox(height: 12),
            LinkedTokensSection(
              tokens: token.linkedTokens,
              onOpen: (t) => pushScreen<void>(
                context,
                TokenScreen(tokenId: t.id),
              ),
              onViewAll: () => pushScreen<void>(
                context,
                LinkedTokensScreen(tokenId: token.id),
              ),
            ),
          ],
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Details', style: theme.textTheme.titleMedium),
                  const SizedBox(height: 8),
                  if (doctor != null)
                    InfoLine(
                      icon: Icons.person,
                      text: '${doctor.fullName} · ${doctor.specialty}',
                    ),
                  if (token.branch != null)
                    InfoLine(
                      icon: Icons.local_hospital,
                      text: token.branch!.name,
                    ),
                  if (token.servicePoint != null)
                    InfoLine(
                      icon: Icons.meeting_room,
                      text: token.servicePoint!.name,
                    ),
                  if (issuedAt != null)
                    InfoLine(
                      icon: Icons.confirmation_number_outlined,
                      text: 'Issued ${formatDateTime(issuedAt)}',
                    ),
                  if (estimate != null && token.isWaiting)
                    InfoLine(
                      icon: Icons.insights,
                      text: estimate.isBaseline
                          ? "Estimate based on the doctor's average "
                              'consultation time. It updates as the queue '
                              'moves.'
                          : 'AI estimate (model ${estimate.modelVersion}). '
                              'It updates as the queue moves.',
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          if (token.canCancel)
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: theme.colorScheme.error,
                side: BorderSide(color: theme.colorScheme.error, width: 1.5),
              ),
              onPressed: _cancelling ? null : () => _cancel(token),
              icon: _cancelling
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    )
                  : const Icon(Icons.cancel_outlined),
              label: const Text('Cancel this token'),
            ),
          if (!token.isActive) ...[
            Text(
              _finishedMessage(token.status),
              style: theme.textTheme.bodyLarge,
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _backToHome,
              icon: const Icon(Icons.home),
              label: const Text('Back to home'),
            ),
          ],
        ],
      ),
    );
  }

  static String _finishedMessage(String status) {
    switch (status) {
      case TokenStatus.completed:
        return 'This visit step is complete. You can rate your visit from '
            'History & feedback.';
      case TokenStatus.cancelled:
        return 'This token was cancelled.';
      case TokenStatus.skipped:
        return 'You missed your call. Please speak to the staff at the '
            'counter - they can recall your token.';
      case TokenStatus.transferred:
        return 'This token was transferred. Your new token is shown on the '
            'Home screen.';
      case TokenStatus.noShow:
        return 'This token was closed because you did not arrive.';
      default:
        return 'This token is no longer active.';
    }
  }
}

/// "Live" / "Offline" indicator for the real-time channel (NFR-01).
class _LiveIndicator extends StatelessWidget {
  const _LiveIndicator({required this.connected});

  final ValueListenable<bool> connected;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: connected,
      builder: (context, isLive, _) {
        final color = isLive ? const Color(0xFF1B5E20) : const Color(0xFF5F5F5F);
        return Semantics(
          label: isLive ? 'Live updates on' : 'Live updates offline',
          excludeSemantics: true,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: isLive ? const Color(0xFFC8E6C9) : const Color(0xFFE0E0E0),
              borderRadius: const BorderRadius.all(Radius.circular(16)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.circle, size: 12, color: color),
                const SizedBox(width: 6),
                Text(
                  isLive ? 'Live' : 'Offline',
                  style: TextStyle(color: color, fontWeight: FontWeight.w700),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
