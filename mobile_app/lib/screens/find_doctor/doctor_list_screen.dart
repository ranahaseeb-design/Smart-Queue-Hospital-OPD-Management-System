import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/directory.dart';
import '../../navigation.dart';
import '../../services/opd_api.dart';
import '../../utils/format.dart';
import '../../widgets/async_views.dart';
import '../../widgets/estimate_range_text.dart';
import '../../widgets/info_widgets.dart';
import '../../widgets/status_chip.dart';
import '../book_appointment_screen.dart';
import '../join_queue_screen.dart';
import 'branch_list_screen.dart';

/// Find Doctor, step 3 of 3: the department's doctors on the selected day
/// (FR-02: "seeing which doctors are scheduled and available on the selected
/// day"). Today shows the live queue length, estimated wait, session and an
/// "accepting" badge with *Join queue* (FR-03); a later day shows who works
/// that day and offers *Book an appointment* (FR-10), because remote tokens
/// are only issued for today.
class DoctorListScreen extends StatefulWidget {
  const DoctorListScreen({
    super.key,
    required this.branch,
    required this.department,
  });

  final Branch branch;
  final Department department;

  @override
  State<DoctorListScreen> createState() => _DoctorListScreenState();
}

class _DoctorListScreenState extends State<DoctorListScreen> {
  /// Today plus the following days offered in the day picker.
  static const int _daysShown = 7;

  /// Midnight of the selected day.
  late DateTime _day;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _day = DateTime(now.year, now.month, now.day);
  }

  bool get _isToday => isSameDay(_day, DateTime.now());

  /// Doctors accepting patients first, then the shortest estimated wait.
  static List<DoctorSummary> _sorted(List<DoctorSummary> doctors) {
    int rank(DoctorSummary d) => d.acceptingNow ? 0 : (d.availableToday ? 1 : 2);
    return [...doctors]..sort((a, b) {
        final r = rank(a).compareTo(rank(b));
        if (r != 0) return r;
        final aw = a.estimatedWaitMinutes ?? 1 << 20;
        final bw = b.estimatedWaitMinutes ?? 1 << 20;
        return aw.compareTo(bw);
      });
  }

  Future<List<DoctorSummary>> _load() async {
    final api = context.read<OpdApi>();
    // Today: let the server use its own date (hospital time zone).
    final doctors = await api.doctors(
      widget.department.id,
      date: _isToday ? null : _day,
    );
    return _sorted(doctors);
  }

  @override
  Widget build(BuildContext context) {
    final branch = widget.branch;
    final department = widget.department;
    final isToday = _isToday;
    final day = _day;

    return Scaffold(
      appBar: AppBar(title: Text(department.title)),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _DayPicker(
              selected: day,
              daysShown: _daysShown,
              onSelected: (d) => setState(() => _day = d),
            ),
            Expanded(
              child: AsyncLoader<List<DoctorSummary>>(
                // A new day starts a fresh load.
                key: ValueKey<DateTime>(day),
                load: _load,
                loadingMessage: 'Loading doctors and queues…',
                isEmpty: (list) => list.isEmpty,
                emptyBuilder: (context, reload) => EmptyView(
                  icon: Icons.person_search,
                  title: 'No doctors listed',
                  message: 'No doctor is assigned to this department yet.',
                  action: ShortestWaitCard(specialty: department.specialty),
                ),
                builder: (context, doctors, reload) => ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                  children: [
                    SectionTitle(
                      'Step 3 of 3: Choose a doctor',
                      subtitle: isToday
                          ? '${branch.name} · today, ${formatDate(day)}'
                          : '${branch.name} · ${formatDate(day)}. Queue '
                              'tokens are issued on the day; you can book an '
                              'appointment now.',
                    ),
                    for (final doctor in doctors) ...[
                      _DoctorCard(
                        doctor: doctor,
                        day: day,
                        isToday: isToday,
                        onJoin: () => pushScreen<void>(
                          context,
                          JoinQueueScreen(
                            doctor: doctor,
                            branch: branch,
                            department: department,
                          ),
                        ),
                        onBook: () => pushScreen<bool>(
                          context,
                          BookAppointmentScreen(
                            initialBranch: branch,
                            initialDepartment: department,
                            initialDoctor: doctor,
                            initialDate: day,
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (isToday)
                      ShortestWaitCard(specialty: department.specialty),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Horizontal row of day chips: Today, Tomorrow, then weekday + date.
class _DayPicker extends StatelessWidget {
  const _DayPicker({
    required this.selected,
    required this.daysShown,
    required this.onSelected,
  });

  final DateTime selected;
  final int daysShown;
  final ValueChanged<DateTime> onSelected;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return SizedBox(
      height: 64,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: daysShown,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final day = DateTime(today.year, today.month, today.day + i);
          final label = switch (i) {
            0 => 'Today',
            1 => 'Tomorrow',
            _ => formatShortDay(day),
          };
          return Center(
            child: ChoiceChip(
              label: Text(label, style: const TextStyle(fontSize: 16)),
              selected: isSameDay(day, selected),
              onSelected: (_) => onSelected(day),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
            ),
          );
        },
      ),
    );
  }
}

class _DoctorCard extends StatelessWidget {
  const _DoctorCard({
    required this.doctor,
    required this.day,
    required this.isToday,
    required this.onJoin,
    required this.onBook,
  });

  final DoctorSummary doctor;
  final DateTime day;
  final bool isToday;
  final VoidCallback onJoin;
  final VoidCallback onBook;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final session = doctor.session;
    final wait = doctor.estimatedWaitMinutes;
    final room = doctor.servicePointName;
    final dayLabel = isToday ? 'Today' : formatShortDay(day);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(doctor.fullName, style: theme.textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(doctor.specialty, style: theme.textTheme.bodyLarge),
            const SizedBox(height: 8),
            AcceptingChip(
              acceptingNow: doctor.acceptingNow,
              availableToday: doctor.availableToday,
              isToday: isToday,
            ),
            const SizedBox(height: 8),
            InfoLine(
              icon: Icons.schedule,
              text: session == null
                  ? (isToday ? 'No session today' : 'No session on this day')
                  : '$dayLabel ${formatHm(session.startTime)} – '
                      '${formatHm(session.endTime)}',
            ),
            if (room != null && room.isNotEmpty)
              InfoLine(icon: Icons.meeting_room, text: room),
            if (isToday) ...[
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: StatBox(
                      label: 'In queue now',
                      value: '${doctor.queueLength}',
                    ),
                  ),
                  Expanded(
                    flex: 2,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Estimated wait',
                            style: theme.textTheme.bodyMedium),
                        const SizedBox(height: 2),
                        if (wait != null && doctor.availableToday)
                          EstimateRangeText.fromMinutes(
                            wait,
                            style: theme.textTheme.headlineSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          )
                        else
                          Text('–', style: theme.textTheme.headlineSmall),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: doctor.acceptingNow ? onJoin : null,
                  icon: const Icon(Icons.add_circle_outline),
                  label: Text(
                    doctor.acceptingNow ? 'Join queue' : 'Queue closed now',
                  ),
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: onBook,
                  icon: const Icon(Icons.event_available),
                  label: const Text('Book an appointment'),
                ),
              ),
            ] else ...[
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: doctor.availableToday ? onBook : null,
                  icon: const Icon(Icons.event_available),
                  label: Text(
                    doctor.availableToday
                        ? 'Book an appointment'
                        : 'Not working this day',
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
