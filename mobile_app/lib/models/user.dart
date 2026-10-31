import 'json_utils.dart';

/// Priority categories a patient may register with (FR-01, FR-13).
/// ELDERLY / DIFFERENTLY_ABLED tokens get priority level 1 when issued.
class PriorityCategory {
  PriorityCategory._();

  static const String none = 'NONE';
  static const String elderly = 'ELDERLY';
  static const String differentlyAbled = 'DIFFERENTLY_ABLED';

  static const List<String> values = [none, elderly, differentlyAbled];

  static String label(String value) {
    switch (value) {
      case elderly:
        return 'Elderly (senior citizen)';
      case differentlyAbled:
        return 'Differently-abled';
      default:
        return 'None';
    }
  }

  static const String explanation =
      'Elderly and differently-abled patients are placed ahead of normal '
      'tokens in the queue. Hospital staff may confirm your category at the '
      'counter. Emergencies are always handled by hospital staff.';
}

/// `User` shape from the API contract (patient-facing subset).
class AppUser {
  const AppUser({
    required this.id,
    required this.fullName,
    required this.role,
    required this.priorityCategory,
    this.email,
    this.phone,
    this.dateOfBirth,
    this.isActive = true,
  });

  final int id;
  final String fullName;
  final String? email;
  final String? phone;
  final String role;

  /// "YYYY-MM-DD" or null.
  final String? dateOfBirth;
  final String priorityCategory;
  final bool isActive;

  bool get isPatient => role == 'PATIENT';

  /// What to show as the login identifier in the UI.
  String get contactLine {
    final parts = <String>[
      if (email != null && email!.isNotEmpty) email!,
      if (phone != null && phone!.isNotEmpty) phone!,
    ];
    return parts.join('  |  ');
  }

  factory AppUser.fromJson(Json json) => AppUser(
        id: asInt(json['id']),
        fullName: asString(json['fullName']),
        email: asStringOrNull(json['email']),
        phone: asStringOrNull(json['phone']),
        role: asString(json['role'], 'PATIENT'),
        dateOfBirth: asStringOrNull(json['dateOfBirth']),
        priorityCategory:
            asString(json['priorityCategory'], PriorityCategory.none),
        isActive: asBool(json['isActive'], true),
      );

  Json toJson() => {
        'id': id,
        'fullName': fullName,
        'email': email,
        'phone': phone,
        'role': role,
        'dateOfBirth': dateOfBirth,
        'priorityCategory': priorityCategory,
        'isActive': isActive,
      };
}
