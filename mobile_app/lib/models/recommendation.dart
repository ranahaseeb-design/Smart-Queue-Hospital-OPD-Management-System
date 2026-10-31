import 'json_utils.dart';

/// One ranked candidate from `GET /recommendations` (FR-08).
class RecommendationItem {
  const RecommendationItem({
    required this.branchId,
    required this.branchName,
    required this.doctorId,
    required this.doctorName,
    required this.predictedWaitMinutes,
    required this.congestionRatio,
    required this.congestionLevel,
    required this.score,
    required this.reason,
    this.address,
    this.distanceKm,
  });

  final int branchId;
  final String branchName;
  final String? address;
  final int doctorId;
  final String doctorName;
  final int predictedWaitMinutes;

  /// Null when the patient did not share a location.
  final double? distanceKm;
  final double congestionRatio;
  final String congestionLevel;

  /// Lower is better (Eq. 6.3).
  final double score;
  final String reason;

  factory RecommendationItem.fromJson(Json json) => RecommendationItem(
        branchId: asInt(json['branchId']),
        branchName: asString(json['branchName']),
        address: asStringOrNull(json['address']),
        doctorId: asInt(json['doctorId']),
        doctorName: asString(json['doctorName']),
        predictedWaitMinutes: asInt(json['predictedWaitMinutes']),
        distanceKm: asDoubleOrNull(json['distanceKm']),
        congestionRatio: asDouble(json['congestionRatio']),
        congestionLevel: asString(json['congestionLevel'], 'NORMAL'),
        score: asDouble(json['score']),
        reason: asString(json['reason']),
      );
}

class RecommendationWeights {
  const RecommendationWeights(
      {required this.wait, required this.distance, required this.congestion});

  final double wait;
  final double distance;
  final double congestion;

  factory RecommendationWeights.fromJson(Json json) => RecommendationWeights(
        wait: asDouble(json['wait']),
        distance: asDouble(json['distance']),
        congestion: asDouble(json['congestion']),
      );
}

class RecommendationResult {
  const RecommendationResult({
    required this.specialty,
    required this.weights,
    required this.items,
  });

  final String specialty;
  final RecommendationWeights weights;
  final List<RecommendationItem> items;

  factory RecommendationResult.fromJson(Json json) {
    final items = asJsonList(json['items'])
        .map(RecommendationItem.fromJson)
        .toList()
      // The server already sorts ascending; keep it deterministic anyway.
      ..sort((a, b) => a.score.compareTo(b.score));
    return RecommendationResult(
      specialty: asString(json['specialty']),
      weights: RecommendationWeights.fromJson(asJson(json['weights'])),
      items: items,
    );
  }
}
