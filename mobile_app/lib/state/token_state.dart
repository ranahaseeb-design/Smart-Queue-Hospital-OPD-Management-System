import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/token.dart';
import '../services/api_client.dart';
import '../services/opd_api.dart';
import '../services/socket_service.dart';
import '../utils/errors.dart';

/// The active tokens of one visit (one branch, one day) plus the other
/// tokens of that visit that are not active themselves - for example the
/// completed OPD consultation behind a waiting LAB token (FR-04).
class ActiveVisit {
  const ActiveVisit({
    required this.visitId,
    required this.tokens,
    required this.linked,
  });

  final int visitId;

  /// Active (WAITING / CALLED / IN_SERVICE) tokens, shown as large cards.
  final List<TokenDetail> tokens;

  /// Remaining tokens of the visit, each listed once.
  final List<TokenDetail> linked;
}

/// Groups active tokens by visit, keeping the order of [tokens]. A linked
/// token that is itself active is shown as a card, so it is not repeated in
/// [ActiveVisit.linked].
List<ActiveVisit> groupTokensByVisit(List<TokenDetail> tokens) {
  final byVisit = <int, List<TokenDetail>>{};
  for (final token in tokens) {
    byVisit.putIfAbsent(token.visitId, () => <TokenDetail>[]).add(token);
  }
  return [
    for (final entry in byVisit.entries)
      ActiveVisit(
        visitId: entry.key,
        tokens: entry.value,
        linked: _otherTokensOfVisit(entry.value),
      ),
  ];
}

List<TokenDetail> _otherTokensOfVisit(List<TokenDetail> shown) {
  final seen = shown.map((t) => t.id).toSet();
  final result = <TokenDetail>[];
  for (final token in shown) {
    for (final linked in token.linkedTokens) {
      if (seen.add(linked.id)) result.add(linked);
    }
  }
  return result;
}

/// The patient's active tokens across all queues (FR-03, FR-04, FR-05).
///
/// Re-fetches `GET /tokens/active` whenever the socket reports a change for
/// one of the patient's tokens (`token:updated` reaches `user:<id>`), so the
/// Home screen is live without manual refresh (FR-05, FR-07).
class TokenState extends ChangeNotifier {
  TokenState(this._api, this._socket, {Duration? pollInterval})
      : _pollInterval = pollInterval ?? const Duration(seconds: 45) {
    _subscriptions
      ..add(_socket.tokenUpdates.listen((_) => _scheduleRefresh()))
      ..add(_socket.onConnected.listen((_) => _scheduleRefresh()));
  }

  final OpdApi _api;
  final SocketService _socket;
  final Duration _pollInterval;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  Timer? _debounce;

  /// Safety net while the real-time channel is down (NFR-01): the Home
  /// screen keeps refreshing every [_pollInterval] until the socket is back.
  Timer? _poll;
  bool _enabled = false;
  bool _refreshing = false;
  bool _refreshAgain = false;

  /// Session generation, bumped by [start] and [clear]. A refresh captures it
  /// before awaiting and drops its response when it changed meanwhile, so a
  /// request from the previous patient's session never lands after
  /// logout/login.
  int _session = 0;

  List<TokenDetail> _tokens = const [];
  bool _loading = false;
  bool _loaded = false;
  String? _error;

  List<TokenDetail> get tokens => _tokens;
  bool get loading => _loading;

  /// True after the first successful load.
  bool get loaded => _loaded;
  String? get error => _error;
  bool get hasActiveTokens => _tokens.isNotEmpty;

  /// OPD tokens first, then lab/pharmacy, so the consultation is on top.
  List<TokenDetail> get sortedTokens {
    final list = [..._tokens];
    int rank(TokenDetail t) => t.queueType == 'OPD' ? 0 : 1;
    list.sort((a, b) {
      final r = rank(a).compareTo(rank(b));
      if (r != 0) return r;
      final ai = a.issuedAt;
      final bi = b.issuedAt;
      if (ai == null || bi == null) return a.id.compareTo(b.id);
      return ai.compareTo(bi);
    });
    return list;
  }

  /// Active tokens grouped by visit, for the Home screen (FR-04).
  List<ActiveVisit> get activeVisits => groupTokensByVisit(sortedTokens);

  /// Called when the patient's home shell opens.
  void start() {
    // New session: an in-flight refresh of the previous one is now stale and
    // no longer owns the refresh flags.
    _session++;
    _refreshing = false;
    _refreshAgain = false;

    _enabled = true;
    _poll?.cancel();
    _poll = Timer.periodic(_pollInterval, (_) {
      if (!_socket.connected.value) unawaited(refresh());
    });
    unawaited(refresh());
  }

  /// Called on logout.
  void clear() {
    _enabled = false;
    _debounce?.cancel();
    _poll?.cancel();
    _poll = null;
    _tokens = const [];
    _loaded = false;
    _loading = false;
    _error = null;
    // Drop any in-flight refresh of this session (see [_session]).
    _session++;
    _refreshing = false;
    _refreshAgain = false;
    notifyListeners();
  }

  Future<void> refresh() async {
    if (!_enabled) return;
    if (_refreshing) {
      _refreshAgain = true;
      return;
    }
    final session = _session;
    _refreshing = true;
    _loading = true;
    notifyListeners();
    try {
      do {
        _refreshAgain = false;
        try {
          final tokens = await _api.activeTokens();
          if (session != _session) return; // stale: logout/login meanwhile
          _tokens = tokens;
          _loaded = true;
          _error = null;
        } on ApiException catch (e) {
          if (session != _session) return;
          _error = e.message;
        } catch (e) {
          if (session != _session) return;
          // Unexpected response shape: keep the last good list.
          _error = describeError(e);
        }
      } while (_refreshAgain && session == _session);
    } finally {
      // After clear()/start() the newer session owns the flags.
      if (session == _session) {
        _refreshing = false;
        _loading = false;
        notifyListeners();
      }
    }
  }

  /// FR-03: join a doctor's OPD queue. Throws [ApiException] (e.g. 409).
  Future<TokenDetail> joinQueue(int doctorId) async {
    final token = await _api.joinQueue(doctorId);
    unawaited(refresh());
    return token;
  }

  /// Cancel a WAITING token (owner only).
  Future<TokenDetail> cancel(int tokenId) async {
    final token = await _api.cancelToken(tokenId);
    unawaited(refresh());
    return token;
  }

  /// FR-10: appointment check-in turns into a token.
  Future<TokenDetail> checkIn(int appointmentId) async {
    final token = await _api.checkIn(appointmentId);
    unawaited(refresh());
    return token;
  }

  void _scheduleRefresh() {
    if (!_enabled) return;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), refresh);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _poll?.cancel();
    for (final s in _subscriptions) {
      s.cancel();
    }
    super.dispose();
  }
}
