import 'json_utils.dart';

/// Row of `GET /notifications` (FR-11).
class AppNotification {
  const AppNotification({
    required this.id,
    required this.message,
    required this.isRead,
    this.tokenId,
    this.channel = 'IN_APP',
    this.sentAt,
  });

  final int id;
  final int? tokenId;
  final String channel;
  final String message;
  final DateTime? sentAt;
  final bool isRead;

  AppNotification copyWith({bool? isRead}) => AppNotification(
        id: id,
        tokenId: tokenId,
        channel: channel,
        message: message,
        sentAt: sentAt,
        isRead: isRead ?? this.isRead,
      );

  factory AppNotification.fromJson(Json json) => AppNotification(
        id: asInt(json['id']),
        tokenId: asIntOrNull(json['tokenId']),
        channel: asString(json['channel'], 'IN_APP'),
        message: asString(json['message']),
        sentAt: asDateTimeOrNull(json['sentAt']),
        isRead: asBool(json['isRead']),
      );
}
