import 'json_utils.dart';

/// Token statuses from the contract.
class TokenStatus {
  TokenStatus._();

  static const String waiting = 'WAITING';
  static const String called = 'CALLED';
  static const String inService = 'IN_SERVICE';
  static const String skipped = 'SKIPPED';
  static const String transferred = 'TRANSFERRED';
  static const String completed = 'COMPLETED';
  static const String cancelled = 'CANCELLED';
  static const String noShow = 'NO_SHOW';

  static const Set<String> active = {waiting, called, inService};

  static bool isActive(String status) => active.contains(status);
}

class IdName {
  const IdName({required this.id, required this.name});

  final int id;
  final String name;

  static IdName? fromJsonOrNull(Object? value) {
    final json = asJsonOrNull(value);
    if (json == null) return null;
    return IdName(id: asInt(json['id']), name: asString(json['name']));
  }
}

class ServicePointRef {
  const ServicePointRef(
      {required this.id, required this.name, required this.type});

  final int id;
  final String name;
  final String type;

  static ServicePointRef? fromJsonOrNull(Object? value) {
    final json = asJsonOrNull(value);
    if (json == null) return null;
    return ServicePointRef(
      id: asInt(json['id']),
      name: asString(json['name']),
      type: asString(json['type']),
    );
  }
}

class DoctorRef {
  const DoctorRef(
      {required this.id, required this.fullName, required this.specialty});

  final int id;
  final String fullName;
  final String specialty;

  static DoctorRef? fromJsonOrNull(Object? value) {
    final json = asJsonOrNull(value);
    if (json == null) return null;
    return DoctorRef(
      id: asInt(json['id']),
      fullName: asString(json['fullName']),
      specialty: asString(json['specialty']),
    );
  }
}

class NowServing {
  const NowServing({required this.tokenId, required this.displayNumber});

  final int tokenId;
  final String displayNumber;

  static NowServing? fromJsonOrNull(Object? value) {
    final json = asJsonOrNull(value);
    if (json == null) return null;
    return NowServing(
      tokenId: asInt(json['tokenId']),
      displayNumber: asString(json['displayNumber']),
    );
  }
}

/// Predicted waiting time (FR-06). `low`/`high` form the range shown to the
/// patient; `modelVersion` is "baseline" or a Random Forest model version.
class Estimate {
  const Estimate({
    required this.minutes,
    required this.low,
    required this.high,
    required this.modelVersion,
  });

  final int minutes;
  final int low;
  final int high;
  final String modelVersion;

  bool get isBaseline => modelVersion.toLowerCase() == 'baseline';

  static Estimate? fromJsonOrNull(Object? value) {
    final json = asJsonOrNull(value);
    if (json == null) return null;
    final minutes = asInt(json['minutes']);
    return Estimate(
      minutes: minutes,
      low: asIntOrNull(json['low']) ?? minutes,
      high: asIntOrNull(json['high']) ?? minutes,
      modelVersion: asString(json['modelVersion'], 'baseline'),
    );
  }
}

/// Live congestion of the token's department (FR-09).
class Congestion {
  const Congestion({required this.level, required this.suggestAlternatives});

  final String level;
  final bool suggestAlternatives;

  static Congestion? fromJsonOrNull(Object? value) {
    final json = asJsonOrNull(value);
    if (json == null) return null;
    return Congestion(
      level: asString(json['level'], 'NORMAL'),
      suggestAlternatives: asBool(json['suggestAlternatives']),
    );
  }
}

/// `TokenDetail` (patient-facing) from the API contract.
class TokenDetail {
  const TokenDetail({
    required this.id,
    required this.visitId,
    required this.tokenNumber,
    required this.displayNumber,
    required this.queueType,
    required this.status,
    required this.priorityLevel,
    this.issuedAt,
    this.calledAt,
    this.completedAt,
    this.branch,
    this.servicePoint,
    this.doctor,
    this.position,
    this.patientsAhead,
    this.nowServing,
    this.estimate,
    this.congestion,
    this.linkedTokens = const [],
  });

  final int id;
  final int visitId;
  final int tokenNumber;
  final String displayNumber;
  final String queueType;
  final String status;
  final int priorityLevel;
  final DateTime? issuedAt;
  final DateTime? calledAt;
  final DateTime? completedAt;
  final IdName? branch;
  final ServicePointRef? servicePoint;
  final DoctorRef? doctor;
  final int? position;
  final int? patientsAhead;
  final NowServing? nowServing;
  final Estimate? estimate;
  final Congestion? congestion;

  /// Other tokens of the same visit (LAB / PHARMACY / transferred OPD) - FR-04.
  final List<TokenDetail> linkedTokens;

  bool get isActive => TokenStatus.isActive(status);
  bool get isWaiting => status == TokenStatus.waiting;
  bool get canCancel => status == TokenStatus.waiting;
  bool get isPriority => priorityLevel > 0;
  /// FR-09 applies to a waiting OPD consultation only: the alternatives are
  /// other branches' doctors of the same specialty, which a LAB / PHARMACY
  /// token cannot switch to (the backend never flags those either).
  bool get suggestAlternatives =>
      isWaiting &&
      queueType == 'OPD' &&
      doctor != null &&
      (congestion?.suggestAlternatives ?? false);

  factory TokenDetail.fromJson(Json json) => TokenDetail(
        id: asInt(json['id']),
        visitId: asInt(json['visitId']),
        tokenNumber: asInt(json['tokenNumber']),
        displayNumber: asString(json['displayNumber'], '#${json['id']}'),
        queueType: asString(json['queueType'], 'OPD'),
        status: asString(json['status'], TokenStatus.waiting),
        priorityLevel: asInt(json['priorityLevel']),
        issuedAt: asDateTimeOrNull(json['issuedAt']),
        calledAt: asDateTimeOrNull(json['calledAt']),
        completedAt: asDateTimeOrNull(json['completedAt']),
        branch: IdName.fromJsonOrNull(json['branch']),
        servicePoint: ServicePointRef.fromJsonOrNull(json['servicePoint']),
        doctor: DoctorRef.fromJsonOrNull(json['doctor']),
        position: asIntOrNull(json['position']),
        patientsAhead: asIntOrNull(json['patientsAhead']),
        nowServing: NowServing.fromJsonOrNull(json['nowServing']),
        estimate: Estimate.fromJsonOrNull(json['estimate']),
        congestion: Congestion.fromJsonOrNull(json['congestion']),
        linkedTokens:
            asJsonList(json['linkedTokens']).map(TokenDetail.fromJson).toList(),
      );
}

/// Human-readable queue names (FR-04).
String queueTypeLabel(String queueType) {
  switch (queueType) {
    case 'LAB':
      return 'Laboratory';
    case 'PHARMACY':
      return 'Pharmacy';
    default:
      return 'OPD consultation';
  }
}
