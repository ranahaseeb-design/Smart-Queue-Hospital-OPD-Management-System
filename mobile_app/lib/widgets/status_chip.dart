import 'package:flutter/material.dart';

import '../models/appointment.dart';
import '../models/token.dart';

/// Visual style of a status chip. Colours are fixed, high-contrast pairs
/// (dark text on a light tint, well above WCAG AA) so status is readable
/// for elderly users (NFR-03) and never conveyed by colour alone (each chip
/// has a text label and an icon).
class ChipStyle {
  const ChipStyle(this.label, this.icon, this.background, this.foreground);

  final String label;
  final IconData icon;
  final Color background;
  final Color foreground;
}

const Color _blueBg = Color(0xFFE3F2FD);
const Color _blueFg = Color(0xFF0D3C8A);
const Color _orangeBg = Color(0xFFFFE0B2);
const Color _orangeFg = Color(0xFF6B2C00);
const Color _tealBg = Color(0xFFB2DFDB);
const Color _tealFg = Color(0xFF00403A);
const Color _greenBg = Color(0xFFC8E6C9);
const Color _greenFg = Color(0xFF1B5E20);
const Color _redBg = Color(0xFFFFCDD2);
const Color _redFg = Color(0xFF7F0000);
const Color _purpleBg = Color(0xFFE1BEE7);
const Color _purpleFg = Color(0xFF4A148C);
const Color _greyBg = Color(0xFFE0E0E0);
const Color _greyFg = Color(0xFF303030);

/// Token status labels in plain words (FR-05, FR-19).
ChipStyle tokenStatusStyle(String status) {
  switch (status) {
    case TokenStatus.waiting:
      return const ChipStyle('Waiting', Icons.hourglass_top, _blueBg, _blueFg);
    case TokenStatus.called:
      return const ChipStyle('Your turn', Icons.campaign, _orangeBg, _orangeFg);
    case TokenStatus.inService:
      return const ChipStyle(
          'Being served', Icons.medical_services, _tealBg, _tealFg);
    case TokenStatus.completed:
      return const ChipStyle('Completed', Icons.check_circle, _greenBg, _greenFg);
    case TokenStatus.skipped:
      return const ChipStyle('Missed', Icons.skip_next, _redBg, _redFg);
    case TokenStatus.transferred:
      return const ChipStyle(
          'Transferred', Icons.swap_horiz, _purpleBg, _purpleFg);
    case TokenStatus.cancelled:
      return const ChipStyle('Cancelled', Icons.cancel, _greyBg, _greyFg);
    case TokenStatus.noShow:
      return const ChipStyle('No-show', Icons.person_off, _greyBg, _greyFg);
    default:
      return ChipStyle(status, Icons.info_outline, _greyBg, _greyFg);
  }
}

/// Appointment status labels (FR-10).
ChipStyle appointmentStatusStyle(String status) {
  switch (status) {
    case AppointmentStatus.booked:
      return const ChipStyle('Booked', Icons.event_available, _blueBg, _blueFg);
    case AppointmentStatus.checkedIn:
      return const ChipStyle('Checked in', Icons.how_to_reg, _tealBg, _tealFg);
    case AppointmentStatus.completed:
      return const ChipStyle('Completed', Icons.check_circle, _greenBg, _greenFg);
    case AppointmentStatus.cancelled:
      return const ChipStyle('Cancelled', Icons.event_busy, _greyBg, _greyFg);
    case AppointmentStatus.noShow:
      return const ChipStyle('Missed', Icons.person_off, _redBg, _redFg);
    default:
      return ChipStyle(status, Icons.info_outline, _greyBg, _greyFg);
  }
}

/// Live congestion level of a department (Eq. 6.5, FR-09).
ChipStyle congestionStyle(String level) {
  switch (level) {
    case 'CRITICAL':
      return const ChipStyle('Very busy', Icons.error, _redBg, _redFg);
    case 'HIGH':
      return const ChipStyle('Busy', Icons.warning_amber, _orangeBg, _orangeFg);
    default:
      return const ChipStyle('Normal', Icons.check_circle, _greenBg, _greenFg);
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.style});

  final ChipStyle style;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: style.label,
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: style.background,
          borderRadius: const BorderRadius.all(Radius.circular(20)),
          border: Border.all(color: style.foreground.withAlpha(80)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(style.icon, size: 18, color: style.foreground),
            const SizedBox(width: 6),
            Text(
              style.label,
              style: TextStyle(
                color: style.foreground,
                fontWeight: FontWeight.w700,
                fontSize: 14,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class TokenStatusChip extends StatelessWidget {
  const TokenStatusChip({super.key, required this.status});

  final String status;

  @override
  Widget build(BuildContext context) =>
      StatusChip(style: tokenStatusStyle(status));
}

class AppointmentStatusChip extends StatelessWidget {
  const AppointmentStatusChip({super.key, required this.status});

  final String status;

  @override
  Widget build(BuildContext context) =>
      StatusChip(style: appointmentStatusStyle(status));
}

class CongestionChip extends StatelessWidget {
  const CongestionChip({super.key, required this.level});

  final String level;

  @override
  Widget build(BuildContext context) =>
      StatusChip(style: congestionStyle(level));
}

/// "Accepting patients" badge on the doctor list (FR-02, FR-03). For a later
/// day ([isToday] false) it only says whether the doctor works that day;
/// `availableToday` then refers to the requested date (`?date=`).
class AcceptingChip extends StatelessWidget {
  const AcceptingChip({
    super.key,
    required this.acceptingNow,
    required this.availableToday,
    this.isToday = true,
  });

  final bool acceptingNow;
  final bool availableToday;
  final bool isToday;

  @override
  Widget build(BuildContext context) {
    if (!isToday) {
      return availableToday
          ? const StatusChip(
              style: ChipStyle(
                  'Works this day', Icons.event_available, _blueBg, _blueFg),
            )
          : const StatusChip(
              style: ChipStyle(
                  'Not working this day', Icons.event_busy, _greyBg, _greyFg),
            );
    }
    if (acceptingNow) {
      return const StatusChip(
        style: ChipStyle(
            'Accepting patients', Icons.check_circle, _greenBg, _greenFg),
      );
    }
    if (availableToday) {
      return const StatusChip(
        style: ChipStyle(
            'Not accepting now', Icons.do_not_disturb_on, _greyBg, _greyFg),
      );
    }
    return const StatusChip(
      style: ChipStyle(
          'Not available today', Icons.event_busy, _greyBg, _greyFg),
    );
  }
}

/// Marks a priority token (FR-13): level 1 elderly / differently-abled,
/// level 2 emergency (set by staff).
class PriorityChip extends StatelessWidget {
  const PriorityChip({super.key, required this.level});

  final int level;

  @override
  Widget build(BuildContext context) {
    return StatusChip(
      style: ChipStyle(
        level >= 2 ? 'Emergency priority' : 'Priority patient',
        Icons.priority_high,
        _purpleBg,
        _purpleFg,
      ),
    );
  }
}
