import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/token.dart';
import '../navigation.dart';
import '../services/opd_api.dart';
import '../services/socket_service.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/async_views.dart';
import '../widgets/info_widgets.dart';
import '../widgets/token_widgets.dart';
import 'token_screen.dart';

/// Linked Tokens (Table 4.19, FR-04): every token of one visit - the OPD
/// consultation and the laboratory / pharmacy tokens that staff issue after
/// it (plus a transferred token, if any) - each with its own live queue
/// position and estimate.
///
/// Opened with any token of the visit; `GET /tokens/:id` returns that token
/// and its `linkedTokens` (same visit, other queues). The screen re-fetches on
/// `token:updated` for any of them; those events reach the patient's
/// `user:<id>` room, which every patient socket joins automatically.
class LinkedTokensScreen extends StatefulWidget {
  const LinkedTokensScreen({super.key, required this.tokenId});

  /// Any token of the visit.
  final int tokenId;

  @override
  State<LinkedTokensScreen> createState() => _LinkedTokensScreenState();
}

class _LinkedTokensScreenState extends State<LinkedTokensScreen> {
  late final OpdApi _api;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  Timer? _debounce;

  TokenDetail? _anchor;
  String? _error;

  @override
  void initState() {
    super.initState();
    _api = context.read<OpdApi>();
    final socket = context.read<SocketService>();
    _subscriptions
      // Every token:updated reaching this socket concerns one of the
      // patient's own tokens, and staff may add a new linked token to this
      // visit at any time, so any event triggers a (debounced) re-fetch.
      ..add(socket.tokenUpdates.listen((_) => _scheduleReload()))
      ..add(socket.onConnected.listen((_) => _scheduleReload()));
    _load();
  }

  @override
  void dispose() {
    for (final s in _subscriptions) {
      s.cancel();
    }
    _debounce?.cancel();
    super.dispose();
  }

  /// All tokens of the visit: active ones first, then by issue time.
  List<TokenDetail> get _visitTokens {
    final anchor = _anchor;
    if (anchor == null) return const [];
    final all = [anchor, ...anchor.linkedTokens];
    all.sort((a, b) {
      final activeOrder = (a.isActive ? 0 : 1).compareTo(b.isActive ? 0 : 1);
      if (activeOrder != 0) return activeOrder;
      final ai = a.issuedAt;
      final bi = b.issuedAt;
      if (ai == null || bi == null) return a.id.compareTo(b.id);
      return ai.compareTo(bi);
    });
    return all;
  }

  void _scheduleReload() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), _load);
  }

  Future<void> _load() async {
    try {
      final anchor = await _api.token(widget.tokenId);
      if (!mounted) return;
      setState(() {
        _anchor = anchor;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = describeError(e));
    }
  }

  void _open(TokenDetail token) =>
      pushScreen<void>(context, TokenScreen(tokenId: token.id));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Linked tokens')),
      body: SafeArea(child: _buildBody(context)),
    );
  }

  Widget _buildBody(BuildContext context) {
    final anchor = _anchor;
    final error = _error;
    if (anchor == null) {
      if (error == null) {
        return const LoadingView(message: 'Loading your visit tokens…');
      }
      return RefreshIndicator(
        onRefresh: _load,
        child: ScrollableFill(child: ErrorView(message: error, onRetry: _load)),
      );
    }

    final theme = Theme.of(context);
    final tokens = _visitTokens;
    final active = tokens.where((t) => t.isActive).toList();
    final finished = tokens.where((t) => !t.isActive).toList();
    final branch = anchor.branch?.name;
    final issued = anchor.issuedAt;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          if (error != null) ...[
            InlineError(message: 'Showing last known status. $error'),
            const SizedBox(height: 12),
          ],
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Your visit', style: theme.textTheme.titleMedium),
                  const SizedBox(height: 6),
                  if (branch != null)
                    InfoLine(icon: Icons.local_hospital, text: branch),
                  if (issued != null)
                    InfoLine(icon: Icons.event, text: formatDate(issued)),
                  const InfoLine(
                    icon: Icons.info_outline,
                    text: 'After your consultation, staff may send you to the '
                        'laboratory or the pharmacy. Each gets its own token '
                        'and queue, shown here.',
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          SectionTitle(
            'In progress',
            subtitle: active.isEmpty
                ? 'No token of this visit is waiting right now.'
                : 'Updates live. Tap a token for its full live view.',
          ),
          for (final token in active) ...[
            TokenHeroCard(token: token, onTap: () => _open(token)),
            const SizedBox(height: 12),
          ],
          if (finished.isNotEmpty) ...[
            const SectionTitle('Finished or closed'),
            Card(
              child: Column(
                children: [
                  for (final token in finished)
                    LinkedTokenTile(token: token, onTap: () => _open(token)),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
