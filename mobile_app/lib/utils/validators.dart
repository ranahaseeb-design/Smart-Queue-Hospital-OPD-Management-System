// Client-side checks that mirror the backend's validation (FR-01). The
// server stays the authority; these only give quicker, friendlier feedback.

final RegExp _emailPattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');
// Same rule as the backend: an optional leading "+", then 10-15 digits.
final RegExp _phonePattern = RegExp(r'^\+?[0-9]{10,15}$');

bool isValidEmail(String value) => _emailPattern.hasMatch(value.trim());

/// Pakistani mobile numbers like 03001234567 or +923001234567; spaces and
/// dashes are ignored.
bool isValidPhone(String value) =>
    _phonePattern.hasMatch(value.replaceAll(RegExp(r'[\s-]'), ''));

String normalizePhone(String value) => value.replaceAll(RegExp(r'[\s-]'), '');

/// Validator for an optional e-mail field.
String? optionalEmail(String? value) {
  final v = value?.trim() ?? '';
  if (v.isEmpty) return null;
  return isValidEmail(v) ? null : 'Please enter a valid e-mail address';
}

/// Validator for an optional phone field.
String? optionalPhone(String? value) {
  final v = value?.trim() ?? '';
  if (v.isEmpty) return null;
  return isValidPhone(v) ? null : 'Please enter a valid phone number';
}

/// Contract: password must be at least 6 characters.
String? newPassword(String? value, {bool required = true}) {
  final v = value ?? '';
  if (v.isEmpty) return required ? 'Please choose a password' : null;
  if (v.length < 6) return 'Password must be at least 6 characters';
  return null;
}

int ageOn(DateTime dateOfBirth, DateTime today) {
  var age = today.year - dateOfBirth.year;
  final hadBirthday = today.month > dateOfBirth.month ||
      (today.month == dateOfBirth.month && today.day >= dateOfBirth.day);
  if (!hadBirthday) age--;
  return age;
}
