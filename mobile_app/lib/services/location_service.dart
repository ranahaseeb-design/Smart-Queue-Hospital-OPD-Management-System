import 'package:geolocator/geolocator.dart';

/// Outcome of asking for the patient's location (FR-08, NFR-05).
class LocationResult {
  const LocationResult._(
    this.latitude,
    this.longitude,
    this.problem, {
    this.blocked = false,
  });

  const LocationResult.success(double latitude, double longitude)
      : this._(latitude, longitude, null);

  const LocationResult.failure(String problem, {bool blocked = false})
      : this._(null, null, problem, blocked: blocked);

  final double? latitude;
  final double? longitude;

  /// Patient-friendly reason when no location is available.
  final String? problem;

  /// True when the permission is permanently denied, so only the phone's
  /// Settings app can grant it.
  final bool blocked;

  bool get hasLocation => latitude != null && longitude != null;
}

/// Wraps geolocator's permission flow. Location is only requested on the
/// Recommendations screen after an explanation, used once for that query and
/// never stored (NFR-05).
class LocationService {
  Future<LocationResult> currentLocation() async {
    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        return const LocationResult.failure(
            'Location is turned off on this phone. Branches are ranked by '
            'waiting time and congestion only.');
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied) {
        return const LocationResult.failure(
            'Location permission was not given. Branches are ranked by '
            'waiting time and congestion only.');
      }
      if (permission == LocationPermission.deniedForever) {
        return const LocationResult.failure(
          'Location permission is blocked. You can allow it in the phone '
          'Settings. Branches are ranked without distance for now.',
          blocked: true,
        );
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.medium,
          timeLimit: Duration(seconds: 15),
        ),
      );
      return LocationResult.success(position.latitude, position.longitude);
    } on Exception {
      // Timeout or platform error: degrade gracefully, never block the user.
      final last = await _lastKnown();
      if (last != null) return last;
      return const LocationResult.failure(
          'Could not get your location right now. Branches are ranked '
          'without distance.');
    }
  }

  Future<LocationResult?> _lastKnown() async {
    try {
      final last = await Geolocator.getLastKnownPosition();
      if (last == null) return null;
      return LocationResult.success(last.latitude, last.longitude);
    } on Exception {
      return null;
    }
  }

  Future<bool> openSettings() => Geolocator.openAppSettings();
}
