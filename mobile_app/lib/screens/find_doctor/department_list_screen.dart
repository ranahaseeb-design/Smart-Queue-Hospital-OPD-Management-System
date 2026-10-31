import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/directory.dart';
import '../../navigation.dart';
import '../../services/opd_api.dart';
import '../../widgets/async_views.dart';
import '../../widgets/info_widgets.dart';
import 'doctor_list_screen.dart';

/// Find Doctor, step 2 of 3: choose a department / specialty (FR-02).
class DepartmentListScreen extends StatelessWidget {
  const DepartmentListScreen({super.key, required this.branch});

  final Branch branch;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(branch.name)),
      body: SafeArea(
        child: AsyncLoader<List<Department>>(
          load: () => context.read<OpdApi>().departments(branch.id),
          loadingMessage: 'Loading departments…',
          isEmpty: (list) => list.isEmpty,
          emptyBuilder: (context, reload) => const EmptyView(
            icon: Icons.medical_services,
            title: 'No departments here',
            message: 'This branch has no open OPD departments right now.',
          ),
          builder: (context, departments, reload) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: [
              const SectionTitle('Step 2 of 3: Choose a department'),
              for (final department in departments)
                Card(
                  child: ListTile(
                    leading: CircleAvatar(
                      child: Icon(specialtyIcon(department.specialty)),
                    ),
                    title: Text(department.title),
                    subtitle: Text(
                      [
                        if (department.specialty != department.title)
                          department.specialty,
                        department.doctorCount == 1
                            ? '1 doctor'
                            : '${department.doctorCount} doctors',
                      ].join(' · '),
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => pushScreen<void>(
                      context,
                      DoctorListScreen(branch: branch, department: department),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
