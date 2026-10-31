// Parses the example shapes from docs/API_CONTRACT.md, so a contract drift
// shows up here instead of as a blank screen. No network needed.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:smart_opd/models/appointment.dart';
import 'package:smart_opd/models/app_notification.dart';
import 'package:smart_opd/models/directory.dart';
import 'package:smart_opd/models/json_utils.dart';
import 'package:smart_opd/models/recommendation.dart';
import 'package:smart_opd/models/token.dart';
import 'package:smart_opd/models/user.dart';
import 'package:smart_opd/models/visit.dart';

Json _decode(String source) => asJson(jsonDecode(source));

void main() {
  test('TokenDetail from the contract example', () {
    final token = TokenDetail.fromJson(_decode('''
{ "id": 42, "visitId": 17, "tokenNumber": 7, "displayNumber": "OPD-007", "queueType": "OPD",
  "status": "WAITING", "priorityLevel": 1, "issuedAt": "2026-10-29T09:12:00", "calledAt": null,
  "completedAt": null, "branch": { "id": 1, "name": "Model Town" },
  "servicePoint": { "id": 3, "name": "Room 1", "type": "OPD" },
  "doctor": { "id": 2, "fullName": "Dr. Sara Ahmed", "specialty": "Cardiology" },
  "position": 4, "patientsAhead": 3,
  "nowServing": { "tokenId": 39, "displayNumber": "OPD-004" },
  "estimate": { "minutes": 30, "low": 24, "high": 36, "modelVersion": "baseline" },
  "congestion": { "level": "HIGH", "suggestAlternatives": true },
  "linkedTokens": [
    { "id": 50, "visitId": 17, "tokenNumber": 3, "displayNumber": "LAB-003", "queueType": "LAB",
      "status": "WAITING", "priorityLevel": 0, "issuedAt": "2026-10-29T10:00:00",
      "doctor": null, "position": 2, "patientsAhead": 1, "nowServing": null,
      "estimate": { "minutes": 8, "low": 3, "high": 13, "modelVersion": "baseline" },
      "congestion": { "level": "NORMAL", "suggestAlternatives": false } }
  ] }
'''));

    expect(token.displayNumber, 'OPD-007');
    expect(token.isWaiting, isTrue);
    expect(token.canCancel, isTrue);
    expect(token.isPriority, isTrue);
    expect(token.issuedAt, DateTime(2026, 10, 29, 9, 12));
    expect(token.branch?.name, 'Model Town');
    expect(token.servicePoint?.name, 'Room 1');
    expect(token.doctor?.specialty, 'Cardiology');
    expect(token.position, 4);
    expect(token.patientsAhead, 3);
    expect(token.nowServing?.displayNumber, 'OPD-004');
    expect(token.estimate?.low, 24);
    expect(token.estimate?.high, 36);
    expect(token.estimate?.isBaseline, isTrue);
    expect(token.suggestAlternatives, isTrue);
    expect(token.linkedTokens, hasLength(1));
    expect(token.linkedTokens.first.queueType, 'LAB');
    expect(token.linkedTokens.first.doctor, isNull);
  });

  test('called token has no position and does not suggest alternatives', () {
    final token = TokenDetail.fromJson(_decode('''
{ "id": 1, "visitId": 1, "tokenNumber": 1, "displayNumber": "OPD-001", "queueType": "OPD",
  "status": "CALLED", "priorityLevel": 0, "position": null, "patientsAhead": 0,
  "estimate": null, "congestion": { "level": "CRITICAL", "suggestAlternatives": true } }
'''));
    expect(token.isActive, isTrue);
    expect(token.canCancel, isFalse);
    expect(token.position, isNull);
    expect(token.estimate, isNull);
    expect(token.suggestAlternatives, isFalse);
  });

  test('User with string numbers is parsed tolerantly', () {
    final user = AppUser.fromJson(_decode('''
{ "id": "5", "fullName": "Ali Khan", "email": "a@x.com", "phone": "03001234567",
  "role": "PATIENT", "dateOfBirth": "1950-01-01", "priorityCategory": "ELDERLY",
  "adminBranchId": null, "isActive": 1, "doctorId": null, "assignments": [] }
'''));
    expect(user.id, 5);
    expect(user.isPatient, isTrue);
    expect(user.isActive, isTrue);
    expect(user.priorityCategory, PriorityCategory.elderly);
    expect(AppUser.fromJson(user.toJson()).email, 'a@x.com');
  });

  test('Appointment and slots', () {
    final appointment = Appointment.fromJson(_decode('''
{ "id": 5, "doctor": { "id": 2, "fullName": "Dr. Sara Ahmed", "specialty": "Cardiology" },
  "branch": { "id": 1, "name": "Model Town" }, "slotStart": "2026-10-30T10:15:00",
  "status": "BOOKED", "updatedAt": "2026-10-29T08:00:00", "tokenId": null }
'''));
    expect(appointment.isBooked, isTrue);
    expect(appointment.slotStart, DateTime(2026, 10, 30, 10, 15));

    final slots = SlotList.fromJson(_decode('''
{ "doctorId": 2, "date": "2026-10-30", "slotMinutes": 15,
  "slots": [ { "start": "2026-10-30T09:00:00", "available": true },
             { "start": "2026-10-30T09:15:00", "available": false } ] }
'''));
    expect(slots.slots, hasLength(2));
    // The raw string is posted back unchanged when booking.
    expect(slots.slots.first.startRaw, '2026-10-30T09:00:00');
    expect(slots.slots.last.available, isFalse);
  });

  test('Doctor list row', () {
    final doctor = DoctorSummary.fromJson(_decode('''
{ "id": 2, "fullName": "Dr. Sara Ahmed", "departmentId": 4, "specialty": "Cardiology",
  "branchId": 1, "avgConsultMinutes": "12.50", "servicePointId": 3, "servicePointName": "Room 1",
  "session": { "startTime": "09:00", "endTime": "13:00" }, "availableToday": true,
  "acceptingNow": true, "queueLength": 6, "estimatedWaitMinutes": 70 }
'''));
    expect(doctor.avgConsultMinutes, 12.5);
    expect(doctor.session?.startTime, '09:00');
    expect(doctor.acceptingNow, isTrue);
    expect(doctor.estimatedWaitMinutes, 70);
  });

  test('Recommendations are kept in ascending score order', () {
    final result = RecommendationResult.fromJson(_decode('''
{ "specialty": "Cardiology", "weights": { "wait": 0.6, "distance": 0.25, "congestion": 0.15 },
  "items": [
    { "branchId": 2, "branchName": "Johar Town", "address": "x", "doctorId": 7, "doctorName": "Dr. B",
      "predictedWaitMinutes": 40, "distanceKm": null, "congestionRatio": 0.9,
      "congestionLevel": "HIGH", "score": 0.7, "reason": "" },
    { "branchId": 3, "branchName": "Gulberg", "address": "y", "doctorId": 9, "doctorName": "Dr. C",
      "predictedWaitMinutes": 15, "distanceKm": 3.2, "congestionRatio": 0.4,
      "congestionLevel": "NORMAL", "score": 0.1, "reason": "About 40 min shorter wait, 3.2 km away" }
  ] }
'''));
    expect(result.weights.wait, 0.6);
    expect(result.items.first.branchName, 'Gulberg');
    expect(result.items.first.distanceKm, 3.2);
    expect(result.items.last.distanceKm, isNull);
  });

  test('Visit history and notifications', () {
    final visits = asJsonList(jsonDecode('''
[ { "id": 17, "visitDate": "2026-10-29", "status": "CLOSED", "branch": { "id": 1, "name": "Model Town" },
    "tokens": [ { "id": 42, "displayNumber": "OPD-007", "queueType": "OPD", "status": "COMPLETED",
                  "issuedAt": "2026-10-29T09:12:00", "calledAt": "2026-10-29T09:40:00",
                  "completedAt": "2026-10-29T09:52:00", "doctorName": "Dr. Sara Ahmed",
                  "servicePointName": "Room 1" } ],
    "feedback": null, "canGiveFeedback": true } ]
''')).map(Visit.fromJson).toList();
    expect(visits.single.canGiveFeedback, isTrue);
    expect(visits.single.feedback, isNull);
    expect(visits.single.tokens.single.actualWait, const Duration(minutes: 28));

    final notification = AppNotification.fromJson(_decode('''
{ "id": 3, "tokenId": 42, "channel": "IN_APP", "message": "Your turn is near", "sentAt": "2026-10-29T09:30:00", "isRead": 0 }
'''));
    expect(notification.isRead, isFalse);
    expect(notification.copyWith(isRead: true).isRead, isTrue);
  });

  // Shapes below were captured from the real backend (SQLite, seed data)
  // during the integration review, trimmed to one item each.
  test('real GET /tokens/active item: linked LAB token, extra keys ignored',
      () {
    final tokens = asJsonList(jsonDecode('''
[{"id":74059,"visitId":41562,"tokenNumber":1,"displayNumber":"LAB-001","queueType":"LAB",
  "status":"WAITING","priorityLevel":0,"issuedAt":"2026-10-31T13:15:24","calledAt":null,
  "completedAt":null,"branch":{"id":1,"name":"Model Town"},
  "servicePoint":{"id":11,"name":"Lab Counter","type":"LAB"},"doctor":null,"position":1,
  "patientsAhead":0,"nowServing":null,
  "estimate":{"minutes":0,"low":0,"high":5,"modelVersion":"baseline"},
  "congestion":{"level":"NORMAL","suggestAlternatives":true},"appointmentId":null,
  "linkedTokens":[{"id":74057,"visitId":41562,"tokenNumber":1,"displayNumber":"OPD-001",
    "queueType":"OPD","status":"COMPLETED","priorityLevel":0,"issuedAt":"2026-10-31T13:13:38",
    "calledAt":"2026-10-31T13:15:22","completedAt":"2026-10-31T13:15:23",
    "branch":{"id":1,"name":"Model Town"},"servicePoint":{"id":2,"name":"Room 2","type":"OPD"},
    "doctor":{"id":2,"fullName":"Dr. Sana Malik","specialty":"General Medicine"},
    "position":null,"patientsAhead":null,"nowServing":null,"estimate":null,
    "congestion":{"level":"NORMAL","suggestAlternatives":false},"appointmentId":null}]}]
''')).map(TokenDetail.fromJson).toList();
    final lab = tokens.single;
    expect(lab.queueType, 'LAB');
    expect(lab.doctor, isNull);
    expect(lab.estimate?.high, 5);
    // FR-09 alternatives are for OPD consultations only, whatever the flag.
    expect(lab.suggestAlternatives, isFalse);
    final opd = lab.linkedTokens.single;
    expect(opd.status, TokenStatus.completed);
    expect(opd.completedAt, DateTime(2026, 10, 31, 13, 15, 23));
    expect(opd.estimate, isNull);
  });

  test('real doctor row (decimal average) and future-day row', () {
    final today = DoctorSummary.fromJson(_decode('''
{"id":1,"fullName":"Dr. Ahmed Raza","departmentId":1,"specialty":"General Medicine",
 "branchId":1,"avgConsultMinutes":10.12,"servicePointId":1,"servicePointName":"Room 1",
 "session":{"startTime":"14:00","endTime":"22:00"},"availableToday":true,"acceptingNow":true,
 "queueLength":3,"estimatedWaitMinutes":87}
'''));
    expect(today.avgConsultMinutes, closeTo(10.12, 1e-9));
    expect(today.estimatedWaitMinutes, 87);
    final later = DoctorSummary.fromJson(_decode('''
{"id":3,"fullName":"Dr. Sara Ahmed","departmentId":2,"specialty":"Cardiology","branchId":1,
 "avgConsultMinutes":13.08,"servicePointId":3,"servicePointName":"Room 3",
 "session":{"startTime":"08:00","endTime":"14:00"},"availableToday":true,
 "acceptingNow":false,"queueLength":0,"estimatedWaitMinutes":null}
'''));
    expect(later.acceptingNow, isFalse);
    expect(later.estimatedWaitMinutes, isNull);
  });

  test('real recommendations without location and real visit row', () {
    final result = RecommendationResult.fromJson(_decode('''
{"specialty":"General Medicine","weights":{"wait":0.8,"distance":0,"congestion":0.2},
 "items":[{"branchId":2,"branchName":"Gulberg","address":"Main Boulevard, Gulberg III, Lahore",
   "doctorId":12,"doctorName":"Dr. Mehwish Iqbal","predictedWaitMinutes":0,"distanceKm":null,
   "congestionRatio":0.03,"congestionLevel":"NORMAL","score":0.05,
   "reason":"Shortest predicted wait (about 0 min)"},
  {"branchId":3,"branchName":"DHA","address":"Sector C, Phase 5, DHA, Lahore","doctorId":20,
   "doctorName":"Dr. Maryam Farooq","predictedWaitMinutes":0,"distanceKm":null,
   "congestionRatio":0,"congestionLevel":"NORMAL","score":0,
   "reason":"Shortest predicted wait (about 0 min), least crowded"}]}
'''));
    expect(result.weights.distance, 0);
    expect(result.items.first.branchName, 'DHA');
    expect(result.items.first.score, 0);
    expect(result.items.first.distanceKm, isNull);

    final visit = Visit.fromJson(_decode('''
{"id":36693,"visitDate":"2026-10-24","status":"CLOSED","branch":{"id":1,"name":"Model Town"},
 "tokens":[{"id":66324,"displayNumber":"LAB-051","queueType":"LAB","status":"COMPLETED",
   "issuedAt":"2026-10-24T18:13:17","calledAt":"2026-10-24T18:14:25",
   "completedAt":"2026-10-24T18:18:06","doctorName":null,"servicePointName":"Lab Counter"}],
 "feedback":{"rating":4,"comment":"Short wait, helpful doctor."},"canGiveFeedback":false}
'''));
    expect(visit.tokens.single.doctorName, isNull);
    expect(visit.tokens.single.actualWait, const Duration(minutes: 1, seconds: 8));
    expect(visit.feedback?.rating, 4);
    expect(visit.canGiveFeedback, isFalse);
  });

  test('Branch and department', () {
    final branch = Branch.fromJson(_decode(
        '{ "id": 1, "name": "Model Town", "address": "Lahore", "latitude": "31.48", "longitude": 74.32, "status": "ACTIVE" }'));
    expect(branch.latitude, 31.48);
    final department = Department.fromJson(_decode(
        '{ "id": 4, "branchId": 1, "specialty": "ENT", "name": "", "doctorCount": 2 }'));
    expect(department.title, 'ENT');
  });
}
