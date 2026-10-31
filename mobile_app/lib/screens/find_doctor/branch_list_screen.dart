import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/directory.dart';
import '../../navigation.dart';
import '../../services/opd_api.dart';
import '../../widgets/async_views.dart';
import '../../widgets/info_widgets.dart';
import '../recommendations_screen.dart';
import 'department_list_screen.dart';

/// Find Doctor, step 1 of 3: choose a branch (FR-02). Used as the body of
/// the "Find doctor" tab.
class BranchListView extends StatelessWidget {
  const BranchListView({super.key});

  @override
  Widget build(BuildContext context) {
    return AsyncLoader<List<Branch>>(
      load: () async {
        final branches = await context.read<OpdApi>().branches();
        return branches.where((b) => b.status == 'ACTIVE').toList();
      },
      loadingMessage: 'Loading hospital branches…',
      isEmpty: (branches) => branches.isEmpty,
      emptyBuilder: (context, reload) => const EmptyView(
        icon: Icons.local_hospital,
        title: 'No branches available',
        message: 'Please try again later.',
      ),
      builder: (context, branches, reload) => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          const SectionTitle(
            'Step 1 of 3: Choose a branch',
            subtitle: 'Then pick a department and a doctor.',
          ),
          for (final branch in branches)
            Card(
              child: ListTile(
                leading: const CircleAvatar(child: Icon(Icons.local_hospital)),
                title: Text(branch.name),
                subtitle: branch.address == null ? null : Text(branch.address!),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => pushScreen<void>(
                  context,
                  DepartmentListScreen(branch: branch),
                ),
              ),
            ),
          const SizedBox(height: 12),
          const ShortestWaitCard(),
        ],
      ),
    );
  }
}

/// Shortcut to the AI branch recommendation (FR-08).
class ShortestWaitCard extends StatelessWidget {
  const ShortestWaitCard({super.key, this.specialty});

  final String? specialty;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      color: theme.colorScheme.tertiaryContainer,
      child: InkWell(
        onTap: () => pushScreen<void>(
          context,
          RecommendationsScreen(initialSpecialty: specialty),
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Icon(
                Icons.alt_route,
                size: 34,
                color: theme.colorScheme.onTertiaryContainer,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Not sure where to go?',
                      style: theme.textTheme.titleMedium?.copyWith(
                        color: theme.colorScheme.onTertiaryContainer,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Compare branches by predicted wait, distance and how '
                      'busy they are.',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onTertiaryContainer,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(
                Icons.chevron_right,
                color: theme.colorScheme.onTertiaryContainer,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
