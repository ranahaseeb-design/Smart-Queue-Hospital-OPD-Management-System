import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/user.dart';
import '../navigation.dart';
import '../state/auth_state.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../utils/validators.dart';
import '../widgets/info_widgets.dart';
import '../widgets/priority_picker.dart';

/// Edit profile (FR-01): only changed fields are sent to `PUT /auth/me`.
class EditProfileScreen extends StatefulWidget {
  const EditProfileScreen({super.key, required this.user});

  final AppUser user;

  @override
  State<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends State<EditProfileScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _email;
  late final TextEditingController _phone;
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  DateTime? _dateOfBirth;
  late String _priority;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final user = widget.user;
    _name = TextEditingController(text: user.fullName);
    _email = TextEditingController(text: user.email ?? '');
    _phone = TextEditingController(text: user.phone ?? '');
    final dob = user.dateOfBirth;
    _dateOfBirth = dob == null ? null : DateTime.tryParse(dob);
    _priority = PriorityCategory.values.contains(user.priorityCategory)
        ? user.priorityCategory
        : PriorityCategory.none;
  }

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _phone.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _pickDateOfBirth() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _dateOfBirth ?? DateTime(now.year - 40, 1, 1),
      firstDate: DateTime(1900),
      lastDate: now,
      initialDatePickerMode: DatePickerMode.year,
      helpText: 'Select your date of birth',
    );
    if (picked != null && mounted) setState(() => _dateOfBirth = picked);
  }

  /// Builds a partial body with only the fields that changed. A cleared
  /// e-mail or phone is sent as null.
  Map<String, dynamic> _changes() {
    final user = widget.user;
    final changes = <String, dynamic>{};
    final name = _name.text.trim();
    final email = _email.text.trim();
    final phone = normalizePhone(_phone.text.trim());
    final dob = _dateOfBirth;
    final dobText = dob == null ? null : apiDate(dob);

    if (name != user.fullName) changes['fullName'] = name;
    if (email != (user.email ?? '')) {
      changes['email'] = email.isEmpty ? null : email;
    }
    if (phone != (user.phone ?? '')) {
      changes['phone'] = phone.isEmpty ? null : phone;
    }
    if (dobText != user.dateOfBirth) changes['dateOfBirth'] = dobText;
    if (_priority != user.priorityCategory) {
      changes['priorityCategory'] = _priority;
    }
    if (_password.text.isNotEmpty) changes['password'] = _password.text;
    return changes;
  }

  Future<void> _save() async {
    final form = _formKey.currentState;
    if (form == null || !form.validate()) return;
    FocusScope.of(context).unfocus();
    final changes = _changes();
    final navigator = Navigator.of(context);
    if (changes.isEmpty) {
      navigator.pop();
      return;
    }
    final auth = context.read<AuthState>();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await auth.updateProfile(changes);
      showAppMessage('Your profile has been saved.');
      // Only pop this screen, never the route below it.
      if (mounted) navigator.pop();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = describeError(e);
      });
    }
  }

  String? _contactValidator() {
    if (_email.text.trim().isEmpty && _phone.text.trim().isEmpty) {
      return 'Keep at least an e-mail address or a phone number';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final error = _error;
    final dob = _dateOfBirth;

    return Scaffold(
      appBar: AppBar(title: const Text('Edit profile')),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              if (error != null) ...[
                InlineError(message: error),
                const SizedBox(height: 16),
              ],
              TextFormField(
                controller: _name,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(
                  labelText: 'Full name',
                  prefixIcon: Icon(Icons.badge),
                ),
                validator: (v) => (v == null || v.trim().length < 2)
                    ? 'Please enter your full name'
                    : null,
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(
                  labelText: 'E-mail',
                  prefixIcon: Icon(Icons.mail_outline),
                ),
                validator: (v) => optionalEmail(v) ?? _contactValidator(),
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(
                  labelText: 'Phone',
                  prefixIcon: Icon(Icons.phone),
                ),
                validator: (v) => optionalPhone(v) ?? _contactValidator(),
              ),
              const SizedBox(height: 20),
              Text('Date of birth', style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _busy ? null : _pickDateOfBirth,
                      icon: const Icon(Icons.cake),
                      label: Text(
                        dob == null ? 'Choose date' : formatDate(dob),
                      ),
                    ),
                  ),
                  if (dob != null)
                    IconButton(
                      tooltip: 'Clear date of birth',
                      onPressed: () => setState(() => _dateOfBirth = null),
                      icon: const Icon(Icons.close),
                    ),
                ],
              ),
              const SizedBox(height: 20),
              PriorityCategoryPicker(
                value: _priority,
                onChanged: (v) => setState(() => _priority = v),
              ),
              const SizedBox(height: 20),
              Text('Change password (optional)',
                  style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              TextFormField(
                controller: _password,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: 'New password',
                  prefixIcon: Icon(Icons.lock_outline),
                ),
                validator: (v) => newPassword(v, required: false),
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _confirm,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: 'Repeat new password',
                  prefixIcon: Icon(Icons.lock_outline),
                ),
                validator: (v) => (_password.text.isNotEmpty &&
                        v != _password.text)
                    ? 'The passwords do not match'
                    : null,
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _busy ? null : _save,
                child: _busy
                    ? const SizedBox(
                        width: 26,
                        height: 26,
                        child: CircularProgressIndicator(strokeWidth: 3),
                      )
                    : const Text('Save changes'),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: _busy ? null : () => Navigator.of(context).pop(),
                child: const Text('Cancel'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
