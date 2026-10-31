import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/user.dart';
import '../state/auth_state.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../utils/validators.dart';
import '../widgets/info_widgets.dart';
import '../widgets/priority_picker.dart';

/// Patient self-registration with e-mail or phone (FR-01). Optional date of
/// birth and priority category (pre-sets token priority, FR-13).
class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _phone = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  DateTime? _dateOfBirth;
  String _priority = PriorityCategory.none;
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _phone.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  bool get _suggestElderly {
    final dob = _dateOfBirth;
    return dob != null &&
        _priority == PriorityCategory.none &&
        ageOn(dob, DateTime.now()) >= 60;
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

  String? _contactValidator() {
    if (_email.text.trim().isEmpty && _phone.text.trim().isEmpty) {
      return 'Enter an e-mail address or a phone number';
    }
    return null;
  }

  Future<void> _submit() async {
    final form = _formKey.currentState;
    if (form == null || !form.validate()) return;
    FocusScope.of(context).unfocus();
    final auth = context.read<AuthState>();
    final dob = _dateOfBirth;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await auth.register(
        fullName: _name.text,
        password: _password.text,
        email: _email.text,
        phone: normalizePhone(_phone.text.trim()),
        dateOfBirth: dob == null ? null : apiDate(dob),
        priorityCategory: _priority,
      );
      // The AuthGate closes this screen and opens the home shell.
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = describeError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final error = _error;
    final dob = _dateOfBirth;

    return Scaffold(
      appBar: AppBar(title: const Text('Create account')),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Text(
                'Enter your details. You need an e-mail address or a phone '
                'number (or both) to log in.',
                style: theme.textTheme.bodyLarge,
              ),
              const SizedBox(height: 20),
              if (error != null) ...[
                InlineError(message: error),
                const SizedBox(height: 16),
              ],
              TextFormField(
                controller: _name,
                textCapitalization: TextCapitalization.words,
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.name],
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
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.email],
                decoration: const InputDecoration(
                  labelText: 'E-mail (optional if phone given)',
                  prefixIcon: Icon(Icons.mail_outline),
                ),
                validator: (v) => optionalEmail(v) ?? _contactValidator(),
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.telephoneNumber],
                decoration: const InputDecoration(
                  labelText: 'Phone (optional if e-mail given)',
                  hintText: '03001234567',
                  prefixIcon: Icon(Icons.phone),
                ),
                validator: (v) => optionalPhone(v) ?? _contactValidator(),
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _password,
                obscureText: _obscure,
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.newPassword],
                decoration: InputDecoration(
                  labelText: 'Password (at least 6 characters)',
                  prefixIcon: const Icon(Icons.lock_outline),
                  suffixIcon: IconButton(
                    tooltip: _obscure ? 'Show password' : 'Hide password',
                    icon: Icon(
                      _obscure ? Icons.visibility : Icons.visibility_off,
                    ),
                    onPressed: () => setState(() => _obscure = !_obscure),
                  ),
                ),
                validator: (v) => newPassword(v),
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _confirm,
                obscureText: _obscure,
                textInputAction: TextInputAction.done,
                decoration: const InputDecoration(
                  labelText: 'Repeat password',
                  prefixIcon: Icon(Icons.lock_outline),
                ),
                validator: (v) => v != _password.text
                    ? 'The passwords do not match'
                    : null,
              ),
              const SizedBox(height: 20),
              Text('Date of birth (optional)',
                  style: theme.textTheme.titleMedium),
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
              if (_suggestElderly) ...[
                const SizedBox(height: 8),
                Text(
                  'Patients aged 60 or above can choose "Elderly" below.',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.primary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
              const SizedBox(height: 20),
              PriorityCategoryPicker(
                value: _priority,
                onChanged: (v) => setState(() => _priority = v),
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(
                        width: 26,
                        height: 26,
                        child: CircularProgressIndicator(strokeWidth: 3),
                      )
                    : const Text('Create account'),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }
}
