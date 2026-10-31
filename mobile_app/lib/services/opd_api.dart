import '../models/app_notification.dart';
import '../models/appointment.dart';
import '../models/directory.dart';
import '../models/json_utils.dart';
import '../models/recommendation.dart';
import '../models/token.dart';
import '../models/user.dart';
import '../models/visit.dart';
import '../utils/format.dart';
import 'api_client.dart';

/// `{ token, user }` returned by register/login.
class AuthResult {
  const AuthResult({required this.jwt, required this.user});

  final String jwt;
  final AppUser user;

  factory AuthResult.fromJson(Json json) => AuthResult(
        jwt: asString(json['token']),
        user: AppUser.fromJson(asJson(json['user'])),
      );
}

/// Typed wrapper around every patient-facing endpoint in
/// docs/API_CONTRACT.md. Screens and state classes use this, never raw URLs.
class OpdApi {
  OpdApi(this.client);

  final ApiClient client;

  // ---------------------------------------------------------------- FR-01
  Future<AuthResult> login(String identifier, String password) async {
    final res = await client.post('/auth/login', {
      'identifier': identifier.trim(),
      'password': password,
    });
    return AuthResult.fromJson(asJson(res));
  }

  Future<AuthResult> register({
    required String fullName,
    required String password,
    String? email,
    String? phone,
    String? dateOfBirth,
    String? priorityCategory,
  }) async {
    final body = <String, dynamic>{
      'fullName': fullName.trim(),
      'password': password,
      if (email != null && email.trim().isNotEmpty) 'email': email.trim(),
      if (phone != null && phone.trim().isNotEmpty) 'phone': phone.trim(),
      if (dateOfBirth != null) 'dateOfBirth': dateOfBirth,
      if (priorityCategory != null) 'priorityCategory': priorityCategory,
    };
    final res = await client.post('/auth/register', body);
    return AuthResult.fromJson(asJson(res));
  }

  Future<AppUser> me() async {
    final res = asJson(await client.get('/auth/me'));
    return AppUser.fromJson(asJson(res['user']));
  }

  /// Only the given fields are sent (PUT /auth/me accepts a partial body).
  Future<AppUser> updateMe(Map<String, dynamic> changes) async {
    final res = asJson(await client.put('/auth/me', changes));
    return AppUser.fromJson(asJson(res['user']));
  }

  // ---------------------------------------------------------------- FR-02
  Future<List<Branch>> branches() async =>
      asJsonList(await client.get('/branches')).map(Branch.fromJson).toList();

  Future<List<String>> specialties() async {
    final res = await client.get('/specialties');
    if (res is List) {
      return res.map((e) => e.toString()).toList();
    }
    return <String>[];
  }

  Future<List<Department>> departments(int branchId) async =>
      asJsonList(await client.get('/branches/$branchId/departments'))
          .map(Department.fromJson)
          .toList();

  Future<List<DoctorSummary>> doctors(int departmentId, {DateTime? date}) async =>
      asJsonList(await client.get(
        '/departments/$departmentId/doctors',
        query: {'date': date == null ? null : apiDate(date)},
      )).map(DoctorSummary.fromJson).toList();

  // ------------------------------------------- FR-03, FR-05, FR-06, FR-07
  Future<TokenDetail> joinQueue(int doctorId) async =>
      TokenDetail.fromJson(asJson(await client.post('/tokens', {'doctorId': doctorId})));

  Future<List<TokenDetail>> activeTokens() async =>
      asJsonList(await client.get('/tokens/active'))
          .map(TokenDetail.fromJson)
          .toList();

  Future<TokenDetail> token(int id) async =>
      TokenDetail.fromJson(asJson(await client.get('/tokens/$id')));

  Future<TokenDetail> cancelToken(int id) async =>
      TokenDetail.fromJson(asJson(await client.delete('/tokens/$id')));

  // ---------------------------------------------------------- FR-08, FR-09
  Future<RecommendationResult> recommendations({
    required String specialty,
    double? latitude,
    double? longitude,
    int? excludeDoctorId,
  }) async {
    final res = await client.get('/recommendations', query: {
      'specialty': specialty,
      'lat': latitude?.toStringAsFixed(5),
      'lng': longitude?.toStringAsFixed(5),
      'excludeDoctorId': excludeDoctorId?.toString(),
    });
    return RecommendationResult.fromJson(asJson(res));
  }

  // ---------------------------------------------------------------- FR-10
  Future<SlotList> slots(int doctorId, DateTime date) async =>
      SlotList.fromJson(asJson(await client.get(
        '/doctors/$doctorId/slots',
        query: {'date': apiDate(date)},
      )));

  Future<List<Appointment>> appointments() async =>
      asJsonList(await client.get('/appointments'))
          .map(Appointment.fromJson)
          .toList();

  Future<Appointment> bookAppointment(int doctorId, String slotStart) async =>
      Appointment.fromJson(asJson(await client.post('/appointments', {
        'doctorId': doctorId,
        'slotStart': slotStart,
      })));

  Future<Appointment> rescheduleAppointment(int id, String slotStart) async =>
      Appointment.fromJson(asJson(
          await client.put('/appointments/$id', {'slotStart': slotStart})));

  Future<Appointment> cancelAppointment(int id) async =>
      Appointment.fromJson(asJson(await client.delete('/appointments/$id')));

  Future<TokenDetail> checkIn(int appointmentId) async => TokenDetail.fromJson(
      asJson(await client.post('/appointments/$appointmentId/check-in')));

  // ---------------------------------------------------------- FR-19, FR-20
  Future<List<Visit>> visits() async =>
      asJsonList(await client.get('/visits')).map(Visit.fromJson).toList();

  Future<void> giveFeedback(int visitId, int rating, String? comment) async {
    await client.post('/visits/$visitId/feedback', {
      'rating': rating,
      if (comment != null && comment.trim().isNotEmpty)
        'comment': comment.trim(),
    });
  }

  // ---------------------------------------------------------------- FR-11
  Future<List<AppNotification>> notifications() async =>
      asJsonList(await client.get('/notifications'))
          .map(AppNotification.fromJson)
          .toList();

  Future<void> markAllNotificationsRead() async {
    await client.post('/notifications/read-all');
  }

  /// For a future FCM integration (see README "Enabling push notifications").
  Future<void> registerDeviceToken(String fcmToken) async {
    await client.post('/notifications/device-token', {'fcmToken': fcmToken});
  }
}
