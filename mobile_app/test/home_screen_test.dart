// Widget tests for the Home screen (Section 4.12: "the active token,
// position and predicted wait are always the first thing shown").
//
// Network-free: the REST API is answered by an in-memory fake built on
// package:http's MockClient with JSON shaped exactly like
// docs/API_CONTRACT.md, and the Socket.IO client is never connected.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:smart_opd/models/token.dart';
import 'package:smart_opd/screens/home_screen.dart';
import 'package:smart_opd/services/api_client.dart';
import 'package:smart_opd/services/auth_service.dart';
import 'package:smart_opd/services/opd_api.dart';
import 'package:smart_opd/services/socket_service.dart';
import 'package:smart_opd/state/auth_state.dart';
import 'package:smart_opd/state/shell_state.dart';
import 'package:smart_opd/state/token_state.dart';

const Map<String, String> _jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
};

/// `GET /tokens/active` example: a waiting OPD token whose visit also has a
/// completed pharmacy token (FR-04).
final List<Map<String, Object?>> _activeTokens = [
  {
    'id': 42,
    'visitId': 17,
    'tokenNumber': 7,
    'displayNumber': 'OPD-007',
    'queueType': 'OPD',
    'status': 'WAITING',
    'priorityLevel': 0,
    'issuedAt': '2026-10-29T09:12:00',
    'calledAt': null,
    'completedAt': null,
    'branch': {'id': 1, 'name': 'Model Town'},
    'servicePoint': {'id': 3, 'name': 'Room 1', 'type': 'OPD'},
    'doctor': {'id': 2, 'fullName': 'Dr. Sara Ahmed', 'specialty': 'Cardiology'},
    'position': 4,
    'patientsAhead': 3,
    'nowServing': {'tokenId': 39, 'displayNumber': 'OPD-004'},
    'estimate': {'minutes': 30, 'low': 24, 'high': 36, 'modelVersion': 'baseline'},
    'congestion': {'level': 'NORMAL', 'suggestAlternatives': false},
    'linkedTokens': [
      {
        'id': 50,
        'visitId': 17,
        'tokenNumber': 12,
        'displayNumber': 'PHARMACY-012',
        'queueType': 'PHARMACY',
        'status': 'COMPLETED',
        'priorityLevel': 0,
        'issuedAt': '2026-10-29T08:30:00',
        'calledAt': '2026-10-29T08:40:00',
        'completedAt': '2026-10-29T08:45:00',
        'branch': {'id': 1, 'name': 'Model Town'},
        'servicePoint': {'id': 9, 'name': 'Pharmacy counter', 'type': 'PHARMACY'},
        'doctor': null,
        'position': null,
        'patientsAhead': null,
        'nowServing': null,
        'estimate': null,
        'congestion': {'level': 'NORMAL', 'suggestAlternatives': false},
      },
    ],
  },
];

/// Fake backend: answers `METHOD /api/path` from [routes], 404 otherwise.
http.Client _fakeBackend(Map<String, Object?> routes) {
  return MockClient((request) async {
    final key = '${request.method} ${request.url.path}';
    if (!routes.containsKey(key)) {
      return http.Response(
        jsonEncode({
          'error': {'code': 'NOT_FOUND', 'message': 'No fake route for $key'},
        }),
        404,
        headers: _jsonHeaders,
      );
    }
    return http.Response(jsonEncode(routes[key]), 200, headers: _jsonHeaders);
  });
}

class _Harness {
  _Harness(Map<String, Object?> routes) {
    final client = ApiClient(
      baseUrl: 'http://fake-backend',
      httpClient: _fakeBackend(routes),
    )..token = 'test-jwt';
    api = OpdApi(client);
    final socket = SocketService(url: 'http://fake-backend');
    tokens = TokenState(api, socket);
    auth = AuthState(
      client: client,
      api: api,
      storage: AuthService(),
      socket: socket,
    );
  }

  late final OpdApi api;
  late final TokenState tokens;
  late final AuthState auth;

  Widget build() {
    return MultiProvider(
      providers: [
        Provider<OpdApi>.value(value: api),
        ChangeNotifierProvider<AuthState>.value(value: auth),
        ChangeNotifierProvider<TokenState>.value(value: tokens),
        ChangeNotifierProvider<ShellState>(create: (_) => ShellState()),
      ],
      child: const MaterialApp(home: Scaffold(body: HomeScreen())),
    );
  }
}

void _useTallPhoneScreen(WidgetTester tester) {
  tester.view.physicalSize = const Size(480, 1600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets('shows the active token first: number, position, now serving, '
      'estimate range and linked tokens', (tester) async {
    _useTallPhoneScreen(tester);
    final harness = _Harness({
      'GET /api/tokens/active': _activeTokens,
      'GET /api/appointments': <Object>[],
    });

    await tester.pumpWidget(harness.build());
    harness.tokens.start();
    await tester.pumpAndSettle();

    expect(find.text('Your token'), findsOneWidget);
    expect(find.text('OPD-007'), findsOneWidget);
    expect(find.text('Waiting'), findsOneWidget);
    expect(find.text('Your position'), findsOneWidget);
    expect(find.text('4'), findsOneWidget);
    expect(find.text('Patients ahead'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    expect(find.text('OPD-004'), findsOneWidget);
    // Shown as a range, never as one exact number (Section 4.12).
    expect(find.text('24–36 min'), findsOneWidget);
    // The completed pharmacy token of the same visit is listed once.
    expect(find.text('PHARMACY-012 · Pharmacy'), findsOneWidget);
    expect(find.text('See all tokens of this visit'), findsOneWidget);
    // With a token in hand there is no "no active token" prompt.
    expect(find.text('You have no active token'), findsNothing);
  });

  testWidgets('without an active token it offers to join a queue',
      (tester) async {
    _useTallPhoneScreen(tester);
    final harness = _Harness({
      'GET /api/tokens/active': <Object>[],
      'GET /api/appointments': <Object>[],
    });

    await tester.pumpWidget(harness.build());
    harness.tokens.start();
    await tester.pumpAndSettle();

    expect(find.text('You have no active token'), findsOneWidget);
    expect(find.text('Join a queue'), findsOneWidget);
    expect(find.text('Find the shortest wait'), findsOneWidget);
  });

  testWidgets('a failed load shows the error with a retry button',
      (tester) async {
    _useTallPhoneScreen(tester);
    // No routes: every request gets the contract's 404 error shape.
    final harness = _Harness(const {});

    await tester.pumpWidget(harness.build());
    harness.tokens.start();
    await tester.pumpAndSettle();

    expect(find.text('No fake route for GET /api/tokens/active'),
        findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  test('tokens are grouped by visit and linked tokens are not repeated', () {
    final opd = TokenDetail.fromJson(_activeTokens.first);
    final lab = TokenDetail.fromJson({
      'id': 60,
      'visitId': 17,
      'tokenNumber': 3,
      'displayNumber': 'LAB-003',
      'queueType': 'LAB',
      'status': 'WAITING',
      'priorityLevel': 0,
      'linkedTokens': [
        _activeTokens.first,
        (_activeTokens.first['linkedTokens']! as List<Object?>).first,
      ],
    });
    final otherVisit = TokenDetail.fromJson({
      'id': 70,
      'visitId': 18,
      'tokenNumber': 1,
      'displayNumber': 'OPD-001',
      'queueType': 'OPD',
      'status': 'CALLED',
      'priorityLevel': 0,
    });

    final visits = groupTokensByVisit([opd, lab, otherVisit]);

    expect(visits, hasLength(2));
    expect(visits.first.visitId, 17);
    expect(visits.first.tokens.map((t) => t.displayNumber),
        ['OPD-007', 'LAB-003']);
    // OPD-007 and LAB-003 are cards already; only the pharmacy token remains.
    expect(visits.first.linked.map((t) => t.displayNumber), ['PHARMACY-012']);
    expect(visits.last.tokens.single.displayNumber, 'OPD-001');
    expect(visits.last.linked, isEmpty);
  });
}
