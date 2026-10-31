import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/appointment.dart';
import '../models/directory.dart';
import '../navigation.dart';
import '../services/api_client.dart';
import '../services/opd_api.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/info_widgets.dart';

/// Book a new appointment or reschedule an existing one (FR-10):
/// doctor picker (branch -> department -> doctor), a date, and a grid of
/// free slots from that weekday's schedule. Pops with `true` on success.
class BookAppointmentScreen extends StatefulWidget {
  const BookAppointmentScreen({
    super.key,
    this.reschedule,
    this.initialBranch,
    this.initialDepartment,
    this.initialDoctor,
    this.initialDate,
  });

  /// When set, only the date/time can change (PUT /appointments/:id).
  final Appointment? reschedule;
  final Branch? initialBranch;
  final Department? initialDepartment;
  final DoctorSummary? initialDoctor;

  /// Day pre-selected for a new booking (e.g. the day chosen in Find
  /// Doctor); ignored when outside the bookable range.
  final DateTime? initialDate;

  @override
  State<BookAppointmentScreen> createState() => _BookAppointmentScreenState();
}

class _BookAppointmentScreenState extends State<BookAppointmentScreen> {
  static const int _daysAhead = 14;

  late final OpdApi _api;

  List<Branch>? _branches;
  List<Department>? _departments;
  List<DoctorSummary>? _doctors;
  int? _branchId;
  int? _departmentId;
  int? _doctorId;
  String? _pickerError;

  late DateTime _date;
  SlotList? _slots;
  bool _loadingSlots = false;
  String? _slotsError;
  Slot? _selected;

  bool _submitting = false;
  String? _submitError;

  bool get _isReschedule => widget.reschedule != null;

  @override
  void initState() {
    super.initState();
    _api = context.read<OpdApi>();
    final today = DateTime.now();
    _date = DateTime(today.year, today.month, today.day);

    final reschedule = widget.reschedule;
    if (reschedule != null) {
      _doctorId = reschedule.doctor?.id;
      final slot = reschedule.slotStart;
      // Start on the current appointment's day if it is still ahead.
      if (slot != null && !slot.isBefore(_date)) {
        final day = DateTime(slot.year, slot.month, slot.day);
        if (day.difference(_date).inDays < _daysAhead) _date = day;
      }
    } else {
      final initialDate = widget.initialDate;
      if (initialDate != null) {
        final day =
            DateTime(initialDate.year, initialDate.month, initialDate.day);
        // Rounded hours, so a daylight-saving change cannot shift the day.
        final offset = (day.difference(_date).inHours / 24).round();
        if (offset >= 0 && offset < _daysAhead) _date = day;
      }
      _branchId = widget.initialBranch?.id;
      _departmentId = widget.initialDepartment?.id;
      _doctorId = widget.initialDoctor?.id;
      _loadBranches();
      final branchId = _branchId;
      if (branchId != null) _loadDepartments(branchId);
      final departmentId = _departmentId;
      if (departmentId != null) _loadDoctors(departmentId);
    }
    if (_doctorId != null) {
      _loadingSlots = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _loadSlots();
      });
    }
  }

  // ------------------------------------------------------------ pickers

  Future<void> _loadBranches() async {
    try {
      final list = await _api.branches();
      if (!mounted) return;
      setState(() {
        _branches = list.where((b) => b.status == 'ACTIVE').toList();
        _pickerError = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _pickerError = describeError(e));
    }
  }

  Future<void> _loadDepartments(int branchId) async {
    try {
      final list = await _api.departments(branchId);
      if (!mounted || branchId != _branchId) return;
      setState(() => _departments = list);
    } catch (e) {
      if (!mounted) return;
      setState(() => _pickerError = describeError(e));
    }
  }

  Future<void> _loadDoctors(int departmentId) async {
    try {
      final list = await _api.doctors(departmentId);
      if (!mounted || departmentId != _departmentId) return;
      setState(() => _doctors = list);
    } catch (e) {
      if (!mounted) return;
      setState(() => _pickerError = describeError(e));
    }
  }

  void _onBranchChanged(int? id) {
    if (id == null || id == _branchId) return;
    setState(() {
      _branchId = id;
      _departmentId = null;
      _doctorId = null;
      _departments = null;
      _doctors = null;
      _slots = null;
      _selected = null;
    });
    _loadDepartments(id);
  }

  void _onDepartmentChanged(int? id) {
    if (id == null || id == _departmentId) return;
    setState(() {
      _departmentId = id;
      _doctorId = null;
      _doctors = null;
      _slots = null;
      _selected = null;
    });
    _loadDoctors(id);
  }

  void _onDoctorChanged(int? id) {
    if (id == null || id == _doctorId) return;
    setState(() {
      _doctorId = id;
      _selected = null;
    });
    _loadSlots();
  }

  void _onDateChanged(DateTime date) {
    if (date == _date) return;
    setState(() {
      _date = date;
      _selected = null;
    });
    _loadSlots();
  }

  // -------------------------------------------------------------- slots

  Future<void> _loadSlots() async {
    final doctorId = _doctorId;
    if (doctorId == null) return;
    final date = _date;
    setState(() {
      _loadingSlots = true;
      _slotsError = null;
    });
    try {
      final slots = await _api.slots(doctorId, date);
      if (!mounted || doctorId != _doctorId || date != _date) return;
      setState(() {
        _slots = slots;
        _loadingSlots = false;
      });
    } catch (e) {
      if (!mounted || doctorId != _doctorId || date != _date) return;
      setState(() {
        _slots = null;
        _slotsError = describeError(e);
        _loadingSlots = false;
      });
    }
  }

  // ------------------------------------------------------------- submit

  Future<void> _submit() async {
    final slot = _selected;
    final doctorId = _doctorId;
    if (slot == null || doctorId == null) return;
    final navigator = Navigator.of(context);
    final reschedule = widget.reschedule;
    setState(() {
      _submitting = true;
      _submitError = null;
    });
    try {
      final appointment = reschedule != null
          ? await _api.rescheduleAppointment(reschedule.id, slot.startRaw)
          : await _api.bookAppointment(doctorId, slot.startRaw);
      final when = formatDateTime(appointment.slotStart ?? slot.start);
      showAppMessage(reschedule != null
          ? 'Appointment moved to $when.'
          : 'Appointment booked for $when.');
      // If the patient already left this screen, popping now would close
      // whatever route is on top instead.
      if (mounted) navigator.pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _selected = null;
        _submitError = e.isConflict
            ? 'Sorry, that time was just taken. Please choose another time.'
            : e.message;
      });
      if (e.isConflict) await _loadSlots();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _submitError = describeError(e);
      });
    }
  }

  // -------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final selected = _selected;
    final submitError = _submitError;

    return Scaffold(
      appBar: AppBar(
        title: Text(_isReschedule ? 'Reschedule' : 'Book appointment'),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            if (_isReschedule)
              _CurrentAppointmentCard(appointment: widget.reschedule!)
            else
              ..._buildDoctorPicker(context),
            const SizedBox(height: 16),
            const SectionTitle('Choose a day'),
            _buildDatePicker(context),
            const SizedBox(height: 16),
            const SectionTitle(
              'Choose a time',
              subtitle: 'Greyed-out times are already booked.',
            ),
            _buildSlots(context),
            const SizedBox(height: 20),
            if (submitError != null) ...[
              InlineError(message: submitError),
              const SizedBox(height: 12),
            ],
            FilledButton.icon(
              onPressed: selected == null || _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    )
                  : const Icon(Icons.event_available),
              label: Text(
                selected == null
                    ? 'Select a time first'
                    : '${_isReschedule ? 'Move to' : 'Book'} '
                        '${formatTime(selected.start)}, '
                        '${formatShortDay(selected.start)}',
              ),
            ),
            if (selected != null) ...[
              const SizedBox(height: 8),
              Text(
                'On the day, open Appointments and tap "Check in" to get '
                'your queue token.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium,
              ),
            ],
          ],
        ),
      ),
    );
  }

  List<Widget> _buildDoctorPicker(BuildContext context) {
    final branches = _branches;
    final departments = _departments;
    final doctors = _doctors;
    final error = _pickerError;
    return [
      const SectionTitle('Choose a doctor'),
      if (error != null) ...[
        InlineError(message: error),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: () {
            setState(() => _pickerError = null);
            _loadBranches();
            final branchId = _branchId;
            if (branchId != null) _loadDepartments(branchId);
            final departmentId = _departmentId;
            if (departmentId != null) _loadDoctors(departmentId);
          },
          icon: const Icon(Icons.refresh),
          label: const Text('Try again'),
        ),
        const SizedBox(height: 12),
      ],
      _LabeledDropdown<int>(
        label: 'Branch',
        value: _knownId(_branchId, branches?.map((b) => b.id)),
        loading: branches == null && error == null,
        items: [
          for (final b in branches ?? const <Branch>[])
            DropdownMenuItem<int>(value: b.id, child: Text(b.name)),
        ],
        onChanged: _onBranchChanged,
      ),
      const SizedBox(height: 12),
      _LabeledDropdown<int>(
        label: 'Department',
        value: _knownId(_departmentId, departments?.map((d) => d.id)),
        loading: _branchId != null && departments == null && error == null,
        items: [
          for (final d in departments ?? const <Department>[])
            DropdownMenuItem<int>(value: d.id, child: Text(d.title)),
        ],
        onChanged: _branchId == null ? null : _onDepartmentChanged,
      ),
      const SizedBox(height: 12),
      _LabeledDropdown<int>(
        label: 'Doctor',
        value: _knownId(_doctorId, doctors?.map((d) => d.id)),
        loading: _departmentId != null && doctors == null && error == null,
        items: [
          for (final d in doctors ?? const <DoctorSummary>[])
            DropdownMenuItem<int>(value: d.id, child: Text(d.fullName)),
        ],
        onChanged: _departmentId == null ? null : _onDoctorChanged,
      ),
    ];
  }

  /// A dropdown value must be one of its items; hide it until they load.
  static int? _knownId(int? id, Iterable<int>? ids) {
    if (id == null || ids == null) return null;
    return ids.contains(id) ? id : null;
  }

  Widget _buildDatePicker(BuildContext context) {
    final today = DateTime.now();
    final start = DateTime(today.year, today.month, today.day);
    final days = [
      for (var i = 0; i < _daysAhead; i++)
        DateTime(start.year, start.month, start.day + i),
    ];
    return SizedBox(
      height: 64,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: days.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final day = days[i];
          final label = i == 0
              ? 'Today'
              : i == 1
                  ? 'Tomorrow'
                  : formatShortDay(day);
          return Center(
            child: ChoiceChip(
              label: Text(label, style: const TextStyle(fontSize: 16)),
              selected: isSameDay(day, _date),
              onSelected: (_) => _onDateChanged(day),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
            ),
          );
        },
      ),
    );
  }

  Widget _buildSlots(BuildContext context) {
    final theme = Theme.of(context);
    if (_doctorId == null) {
      return Text(
        _isReschedule
            ? 'This appointment has no doctor attached.'
            : 'Choose a branch, department and doctor first.',
        style: theme.textTheme.bodyLarge,
      );
    }
    if (_loadingSlots) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    final error = _slotsError;
    if (error != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InlineError(message: error),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _loadSlots,
            icon: const Icon(Icons.refresh),
            label: const Text('Try again'),
          ),
        ],
      );
    }
    final slots = _slots?.slots ?? const <Slot>[];
    if (slots.isEmpty) {
      return Text(
        'No times on this day. The doctor may not work on this day, or all '
        'times have passed. Please choose another day.',
        style: theme.textTheme.bodyLarge,
      );
    }
    final current = widget.reschedule?.slotStart;
    final selected = _selected;
    final freeCount = slots.where((s) => s.available).length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (freeCount == 0)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              'This day is fully booked. Please choose another day.',
              style: theme.textTheme.bodyLarge,
            ),
          ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final slot in slots)
              _SlotChip(
                slot: slot,
                selected: selected?.startRaw == slot.startRaw,
                isCurrent: current != null && slot.start == current,
                onSelected: () => setState(() {
                  _selected = slot;
                  _submitError = null;
                }),
              ),
          ],
        ),
      ],
    );
  }
}

class _SlotChip extends StatelessWidget {
  const _SlotChip({
    required this.slot,
    required this.selected,
    required this.isCurrent,
    required this.onSelected,
  });

  final Slot slot;
  final bool selected;
  final bool isCurrent;
  final VoidCallback onSelected;

  @override
  Widget build(BuildContext context) {
    final enabled = slot.available && !isCurrent;
    final time = formatTime(slot.start);
    final label = isCurrent ? '$time (current)' : time;
    return Semantics(
      label: enabled ? 'Free at $time' : 'Not available at $time',
      selected: selected,
      excludeSemantics: true,
      child: ChoiceChip(
        label: Text(
          label,
          style: TextStyle(
            fontSize: 16,
            decoration: enabled ? null : TextDecoration.lineThrough,
          ),
        ),
        selected: selected,
        onSelected: enabled ? (_) => onSelected() : null,
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
      ),
    );
  }
}

class _CurrentAppointmentCard extends StatelessWidget {
  const _CurrentAppointmentCard({required this.appointment});

  final Appointment appointment;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final doctor = appointment.doctor;
    final branch = appointment.branch;
    return Card(
      color: theme.colorScheme.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Current appointment', style: theme.textTheme.titleMedium),
            const SizedBox(height: 6),
            InfoLine(
              icon: Icons.schedule,
              text: formatDateTime(appointment.slotStart),
            ),
            if (doctor != null)
              InfoLine(
                icon: Icons.person,
                text: '${doctor.fullName} · ${doctor.specialty}',
              ),
            if (branch != null) InfoLine(icon: Icons.place, text: branch.name),
          ],
        ),
      ),
    );
  }
}

/// Labelled dropdown that works the same on old and new Flutter versions
/// (DropdownButton inside an InputDecorator).
class _LabeledDropdown<T> extends StatelessWidget {
  const _LabeledDropdown({
    required this.label,
    required this.value,
    required this.items,
    required this.onChanged,
    this.loading = false,
  });

  final String label;
  final T? value;
  final List<DropdownMenuItem<T>> items;
  final ValueChanged<T?>? onChanged;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final enabled = onChanged != null && items.isNotEmpty;
    return InputDecorator(
      decoration: InputDecoration(
        labelText: label,
        enabled: enabled,
        suffixIcon: loading
            ? const Padding(
                padding: EdgeInsets.all(14),
                child: SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2.5),
                ),
              )
            : null,
      ),
      isEmpty: value == null,
      child: DropdownButtonHideUnderline(
        child: DropdownButton<T>(
          value: value,
          isExpanded: true,
          isDense: true,
          style: Theme.of(context).textTheme.bodyLarge,
          items: items,
          onChanged: enabled ? onChanged : null,
        ),
      ),
    );
  }
}
