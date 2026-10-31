// Widget and unit tests that need no network or device plugins.
//
// Run with: flutter test
//
// Note: this file is intentionally named widget_test.dart so that
// `flutter create .` does not generate its default counter-app test here.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smart_opd/models/token.dart';
import 'package:smart_opd/utils/format.dart';
import 'package:smart_opd/widgets/estimate_range_text.dart';
import 'package:smart_opd/widgets/star_rating.dart';
import 'package:smart_opd/widgets/status_chip.dart';
import 'package:smart_opd/widgets/token_widgets.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  group('estimateRangeFor (contract: low = max(0, round(m*0.8)), '
      'high = round(m*1.2), at least +/-5 min)', () {
    test('30 min gives 24..36', () {
      expect(estimateRangeFor(30), const MinuteRange(24, 36));
    });

    test('100 min gives 80..120', () {
      expect(estimateRangeFor(100), const MinuteRange(80, 120));
    });

    test('small values are widened to at least +/-5 min', () {
      expect(estimateRangeFor(10), const MinuteRange(5, 15));
      expect(estimateRangeFor(3), const MinuteRange(0, 8));
    });

    test('never negative', () {
      expect(estimateRangeFor(0), const MinuteRange(0, 5));
      expect(estimateRangeFor(-4), const MinuteRange(0, 5));
    });
  });

  group('formatEstimateRange', () {
    test('shows a range, not a single number', () {
      expect(formatEstimateRange(25, 35), '25–35 min');
    });

    test('swapped bounds are put in order', () {
      expect(formatEstimateRange(36, 24), '24–36 min');
    });

    test('very short waits', () {
      expect(formatEstimateRange(0, 0), 'Any moment now');
      expect(formatEstimateRange(0, 4), 'Less than 5 min');
    });

    test('equal bounds', () {
      expect(formatEstimateRange(20, 20), 'About 20 min');
    });

    test('hours are spelled out', () {
      expect(formatEstimateRange(50, 70), '50 min – 1 h 10 min');
      expect(formatEstimateRange(60, 120), '1 h – 2 h');
    });

    test('single predicted value uses the contract range', () {
      expect(formatEstimateMinutes(30), '24–36 min');
      expect(formatEstimateMinutes(3), '0–8 min');
    });
  });

  group('other formatting', () {
    test('distance', () {
      expect(formatDistanceKm(null), 'Distance unknown');
      expect(formatDistanceKm(0.45), '450 m away');
      expect(formatDistanceKm(3.24), '3.2 km away');
    });

    test('contract date for ?date= and dateOfBirth', () {
      expect(apiDate(DateTime(2026, 11, 1, 23, 59)), '2026-11-01');
      expect(apiDate(DateTime(1950, 3, 2)), '1950-03-02');
    });

    test('HH:mm session times', () {
      expect(formatHm('09:00'), '9:00 AM');
      expect(formatHm('14:30'), '2:30 PM');
      expect(formatHm('bad'), 'bad');
    });

    test('relative notification time', () {
      final now = DateTime(2026, 10, 30, 12, 0);
      expect(formatRelative(DateTime(2026, 10, 30, 11, 59, 40), now: now),
          'just now');
      expect(formatRelative(DateTime(2026, 10, 30, 11, 45), now: now),
          '15 min ago');
    });
  });

  testWidgets('EstimateRangeText shows the range text', (tester) async {
    await tester.pumpWidget(_wrap(const EstimateRangeText(low: 25, high: 35)));
    expect(find.text('25–35 min'), findsOneWidget);
  });

  testWidgets('EstimateRangeText.fromMinutes applies the contract formula',
      (tester) async {
    await tester.pumpWidget(_wrap(EstimateRangeText.fromMinutes(30)));
    expect(find.text('24–36 min'), findsOneWidget);
  });

  testWidgets('EstimateRangeText exposes a spoken label', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_wrap(const EstimateRangeText(low: 25, high: 35)));
    expect(
      find.bySemanticsLabel('Estimated wait 25 to 35 min'),
      findsOneWidget,
    );
    handle.dispose();
  });

  testWidgets('status chips use plain words', (tester) async {
    await tester.pumpWidget(_wrap(const Column(
      children: [
        TokenStatusChip(status: 'WAITING'),
        TokenStatusChip(status: 'CALLED'),
        AppointmentStatusChip(status: 'BOOKED'),
        CongestionChip(level: 'CRITICAL'),
      ],
    )));
    expect(find.text('Waiting'), findsOneWidget);
    expect(find.text('Your turn'), findsOneWidget);
    expect(find.text('Booked'), findsOneWidget);
    expect(find.text('Very busy'), findsOneWidget);
  });

  testWidgets('doctor badge for today and for a later day (FR-02)',
      (tester) async {
    await tester.pumpWidget(_wrap(const Column(
      children: [
        AcceptingChip(acceptingNow: true, availableToday: true),
        AcceptingChip(acceptingNow: false, availableToday: true),
        AcceptingChip(
            acceptingNow: false, availableToday: true, isToday: false),
        AcceptingChip(
            acceptingNow: false, availableToday: false, isToday: false),
      ],
    )));
    expect(find.text('Accepting patients'), findsOneWidget);
    expect(find.text('Not accepting now'), findsOneWidget);
    expect(find.text('Works this day'), findsOneWidget);
    expect(find.text('Not working this day'), findsOneWidget);
  });

  testWidgets('a called token tells the patient where to go', (tester) async {
    final token = TokenDetail.fromJson(const {
      'id': 42,
      'visitId': 17,
      'tokenNumber': 7,
      'displayNumber': 'OPD-007',
      'queueType': 'OPD',
      'status': 'CALLED',
      'priorityLevel': 1,
      'servicePoint': {'id': 3, 'name': 'Room 1', 'type': 'OPD'},
      'position': null,
      'patientsAhead': null,
      'estimate': null,
    });
    await tester.pumpWidget(_wrap(SingleChildScrollView(
      child: TokenHeroCard(token: token),
    )));
    expect(find.text('OPD-007'), findsOneWidget);
    expect(find.text('Your turn'), findsOneWidget);
    expect(find.text('Priority patient'), findsOneWidget);
    expect(find.text("It's your turn! Please go to Room 1 now."),
        findsOneWidget);
    // No waiting-only figures once called.
    expect(find.text('Your position'), findsNothing);
  });

  testWidgets('star rating input reports the tapped star', (tester) async {
    var rating = 0;
    await tester.pumpWidget(_wrap(StatefulBuilder(
      builder: (context, setState) => StarRatingInput(
        value: rating,
        onChanged: (v) => setState(() => rating = v),
      ),
    )));
    expect(find.byIcon(Icons.star_border), findsNWidgets(5));
    await tester.tap(find.byIcon(Icons.star_border).at(3));
    await tester.pump();
    expect(rating, 4);
    expect(find.byIcon(Icons.star), findsNWidgets(4));
  });
}
