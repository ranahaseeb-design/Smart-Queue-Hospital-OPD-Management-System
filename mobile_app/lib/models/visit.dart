import 'json_utils.dart';
import 'token.dart';

/// Token row inside a visit (FR-19).
class VisitToken {
  const VisitToken({
    required this.id,
    required this.displayNumber,
    required this.queueType,
    required this.status,
    this.issuedAt,
    this.calledAt,
    this.completedAt,
    this.doctorName,
    this.servicePointName,
  });

  final int id;
  final String displayNumber;
  final String queueType;
  final String status;
  final DateTime? issuedAt;
  final DateTime? calledAt;
  final DateTime? completedAt;
  final String? doctorName;
  final String? servicePointName;

  /// Actual wait (issued -> called) when known.
  Duration? get actualWait {
    final issued = issuedAt;
    final called = calledAt;
    if (issued == null || called == null) return null;
    return called.difference(issued);
  }

  factory VisitToken.fromJson(Json json) => VisitToken(
        id: asInt(json['id']),
        displayNumber: asString(json['displayNumber']),
        queueType: asString(json['queueType'], 'OPD'),
        status: asString(json['status']),
        issuedAt: asDateTimeOrNull(json['issuedAt']),
        calledAt: asDateTimeOrNull(json['calledAt']),
        completedAt: asDateTimeOrNull(json['completedAt']),
        doctorName: asStringOrNull(json['doctorName']),
        servicePointName: asStringOrNull(json['servicePointName']),
      );
}

class VisitFeedback {
  const VisitFeedback({required this.rating, this.comment});

  final int rating;
  final String? comment;

  static VisitFeedback? fromJsonOrNull(Object? value) {
    final json = asJsonOrNull(value);
    if (json == null) return null;
    return VisitFeedback(
      rating: asInt(json['rating']),
      comment: asStringOrNull(json['comment']),
    );
  }
}

/// Row of `GET /visits` (FR-19, FR-20).
class Visit {
  const Visit({
    required this.id,
    required this.visitDate,
    required this.status,
    required this.tokens,
    required this.canGiveFeedback,
    this.branch,
    this.feedback,
  });

  final int id;

  /// "YYYY-MM-DD"
  final String visitDate;
  final String status;
  final IdName? branch;
  final List<VisitToken> tokens;
  final VisitFeedback? feedback;
  final bool canGiveFeedback;

  factory Visit.fromJson(Json json) => Visit(
        id: asInt(json['id']),
        visitDate: asString(json['visitDate']),
        status: asString(json['status']),
        branch: IdName.fromJsonOrNull(json['branch']),
        tokens: asJsonList(json['tokens']).map(VisitToken.fromJson).toList(),
        feedback: VisitFeedback.fromJsonOrNull(json['feedback']),
        canGiveFeedback: asBool(json['canGiveFeedback']),
      );
}
