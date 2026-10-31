import 'json_utils.dart';
import 'token.dart';

class AppointmentStatus {
  AppointmentStatus._();

  static const String booked = 'BOOKED';
  static const String checkedIn = 'CHECKED_IN';
  static const String cancelled = 'CANCELLED';
  static const String completed = 'COMPLETED';
  static const String noShow = 'NO_SHOW';
}

/// `Appointment` shape from the contract (FR-10).
class Appointment {
  const Appointment({
    required this.id,
    required this.status,
    this.doctor,
    this.branch,
    this.slotStart,
    this.updatedAt,
    this.tokenId,
  });

  final int id;
  final DoctorRef? doctor;
  final IdName? branch;
  final DateTime? slotStart;
  final String status;
  final DateTime? updatedAt;
  final int? tokenId;

  bool get isBooked => status == AppointmentStatus.booked;

  /// Check-in is only possible on the appointment day (contract).
  bool get canCheckIn {
    final slot = slotStart;
    if (!isBooked || slot == null) return false;
    final now = DateTime.now();
    return slot.year == now.year &&
        slot.month == now.month &&
        slot.day == now.day;
  }

  bool get isUpcoming {
    final slot = slotStart;
    return isBooked && slot != null && slot.isAfter(DateTime.now());
  }

  factory Appointment.fromJson(Json json) => Appointment(
        id: asInt(json['id']),
        doctor: DoctorRef.fromJsonOrNull(json['doctor']),
        branch: IdName.fromJsonOrNull(json['branch']),
        slotStart: asDateTimeOrNull(json['slotStart']),
        status: asString(json['status'], AppointmentStatus.booked),
        updatedAt: asDateTimeOrNull(json['updatedAt']),
        tokenId: asIntOrNull(json['tokenId']),
      );
}

class Slot {
  const Slot({required this.startRaw, required this.start, required this.available});

  /// The exact string the server sent; posted back unchanged when booking.
  final String startRaw;
  final DateTime start;
  final bool available;
}

/// `GET /doctors/:id/slots` response.
class SlotList {
  const SlotList({
    required this.doctorId,
    required this.date,
    required this.slotMinutes,
    required this.slots,
  });

  final int doctorId;
  final String date;
  final int slotMinutes;
  final List<Slot> slots;

  factory SlotList.fromJson(Json json) {
    final slots = <Slot>[];
    for (final s in asJsonList(json['slots'])) {
      final raw = asString(s['start']);
      final parsed = asDateTimeOrNull(raw);
      if (parsed == null) continue;
      slots.add(Slot(
        startRaw: raw,
        start: parsed,
        available: asBool(s['available'], true),
      ));
    }
    return SlotList(
      doctorId: asInt(json['doctorId']),
      date: asString(json['date']),
      slotMinutes: asInt(json['slotMinutes'], 15),
      slots: slots,
    );
  }
}
