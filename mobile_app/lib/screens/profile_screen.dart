import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../config.dart';
import '../models/user.dart';
import '../navigation.dart';
import '../state/auth_state.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/dialogs.dart';
import '../widgets/info_widgets.dart';
import 'edit_profile_screen.dart';

/// Profile (FR-01): personal details, priority category and logout.
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  Future<void> _refresh(BuildContext context) async {
    try {
      await context.read<AuthState>().refreshProfile();
    } catch (e) {
      showAppMessage(describeError(e), isError: true);
    }
  }

  Future<void> _logout(BuildContext context) async {
    final auth = context.read<AuthState>();
    final ok = await confirmAction(
      context,
      title: 'Log out?',
      message: 'You will stop receiving live updates on this phone until '
          'you log in again. Your tokens stay active.',
      confirmLabel: 'Log out',
      cancelLabel: 'Stay logged in',
    );
    if (ok) await auth.logout();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final user = context.select<AuthState, AppUser?>((a) => a.user);
    if (user == null) return const SizedBox.shrink();

    final initials = user.fullName
        .trim()
        .split(RegExp(r'\s+'))
        .where((p) => p.isNotEmpty)
        .take(2)
        .map((p) => p[0].toUpperCase())
        .join();
    final dob = user.dateOfBirth;
    final email = user.email;
    final phone = user.phone;

    return RefreshIndicator(
      onRefresh: () => _refresh(context),
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 36,
                backgroundColor: theme.colorScheme.primary,
                foregroundColor: theme.colorScheme.onPrimary,
                child: Text(
                  initials.isEmpty ? '?' : initials,
                  style: const TextStyle(
                    fontSize: 26,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(user.fullName, style: theme.textTheme.titleLarge),
                    Text('Patient', style: theme.textTheme.bodyMedium),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  InfoLine(
                    icon: Icons.mail_outline,
                    text: email == null || email.isEmpty
                        ? 'No e-mail added'
                        : email,
                  ),
                  InfoLine(
                    icon: Icons.phone,
                    text: phone == null || phone.isEmpty
                        ? 'No phone number added'
                        : phone,
                  ),
                  InfoLine(
                    icon: Icons.cake,
                    text: dob == null || dob.isEmpty
                        ? 'Date of birth not given'
                        : 'Born ${formatApiDate(dob)}',
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Priority category', style: theme.textTheme.titleMedium),
                  const SizedBox(height: 4),
                  Text(
                    PriorityCategory.label(user.priorityCategory),
                    style: theme.textTheme.titleLarge,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    PriorityCategory.explanation,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: () => pushScreen<void>(
              context,
              EditProfileScreen(user: user),
            ),
            icon: const Icon(Icons.edit),
            label: const Text('Edit profile'),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(
              foregroundColor: theme.colorScheme.error,
              side: BorderSide(color: theme.colorScheme.error, width: 1.5),
            ),
            onPressed: () => _logout(context),
            icon: const Icon(Icons.logout),
            label: const Text('Log out'),
          ),
          const SizedBox(height: 28),
          Text(
            'Notifications are shown in the app while you are logged in. '
            'Server: ${AppConfig.apiUrl}',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
