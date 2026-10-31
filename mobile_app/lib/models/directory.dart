import 'json_utils.dart';

/// Branch / department / doctor master data for the Find Doctor flow (FR-02).

class Branch {
  const Branch({
    required this.id,
    required this.name,
    this.address,
    this.latitude,
    this.longitude,
    this.status = 'ACTIVE',
  });

  final int id;
  final String name;
  final String? address;
  final double? latitude;
  final double? longitude;
  final String status;

  factory Branch.fromJson(Json json) => Branch(
        id: asInt(json['id']),
        name: asString(json['name']),
        address: asStringOrNull(json['address']),
        latitude: asDoubleOrNull(json['latitude']),
        longitude: asDoubleOrNull(json['longitude']),
        status: asString(json['status'], 'ACTIVE'),
      );
}

class Department {
  const Department({
    required this.id,
    required this.branchId,
    required this.specialty,
    required this.name,
    required this.doctorCount,
  });

  final int id;
  final int branchId;
  final String specialty;
  final String name;
  final int doctorCount;

  /// Department name, falling back to the specialty.
  String get title => name.isNotEmpty ? name : specialty;

  factory Department.fromJson(Json json) => Department(
        id: asInt(json['id']),
        branchId: asInt(json['branchId']),
        specialty: asString(json['specialty']),
        name: asString(json['name']),
        doctorCount: asInt(json['doctorCount']),
      );
}

class DoctorSession {
  const DoctorSession({required this.startTime, required this.endTime});

  /// "HH:mm"
  final String startTime;
  final String endTime;

  static DoctorSession? fromJsonOrNull(Object? value) {
    final json = asJsonOrNull(value);
    if (json == null) return null;
    return DoctorSession(
      startTime: asString(json['startTime']),
      endTime: asString(json['endTime']),
    );
  }
}

/// Row of `GET /departments/:id/doctors`.
class DoctorSummary {
  const DoctorSummary({
    required this.id,
    required this.fullName,
    required this.departmentId,
    required this.specialty,
    required this.branchId,
    required this.avgConsultMinutes,
    required this.availableToday,
    required this.acceptingNow,
    required this.queueLength,
    this.servicePointId,
    this.servicePointName,
    this.session,
    this.estimatedWaitMinutes,
  });

  final int id;
  final String fullName;
  final int departmentId;
  final String specialty;
  final int branchId;
  final double avgConsultMinutes;
  final int? servicePointId;
  final String? servicePointName;
  final DoctorSession? session;
  final bool availableToday;
  final bool acceptingNow;
  final int queueLength;
  final int? estimatedWaitMinutes;

  factory DoctorSummary.fromJson(Json json) => DoctorSummary(
        id: asInt(json['id']),
        fullName: asString(json['fullName']),
        departmentId: asInt(json['departmentId']),
        specialty: asString(json['specialty']),
        branchId: asInt(json['branchId']),
        avgConsultMinutes: asDouble(json['avgConsultMinutes'], 10),
        servicePointId: asIntOrNull(json['servicePointId']),
        servicePointName: asStringOrNull(json['servicePointName']),
        session: DoctorSession.fromJsonOrNull(json['session']),
        availableToday: asBool(json['availableToday']),
        acceptingNow: asBool(json['acceptingNow']),
        queueLength: asInt(json['queueLength']),
        estimatedWaitMinutes: asIntOrNull(json['estimatedWaitMinutes']),
      );
}
