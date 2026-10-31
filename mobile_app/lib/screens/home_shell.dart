import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../navigation.dart';
import '../state/notification_state.dart';
import '../state/shell_state.dart';
import '../state/token_state.dart';
import '../widgets/notification_bell.dart';
import 'appointments_screen.dart';
import 'find_doctor/branch_list_screen.dart';
import 'history_screen.dart';
import 'home_screen.dart';
import 'profile_screen.dart';

/// Patient home shell: bottom navigation with five clearly labelled tabs and
/// the notification bell (Table 4.19 screens).
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  static const List<String> _titles = [
    'Smart OPD',
    'Find a doctor',
    'Appointments',
    'History & feedback',
    'My profile',
  ];

  StreamSubscription<IncomingNotification>? _incoming;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _incoming =
        context.read<NotificationState>().incoming.listen(_onNotification);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _incoming?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Coming back to the app: catch up on anything missed while the socket
    // was paused in the background (FR-05, FR-11).
    if (state == AppLifecycleState.resumed) {
      context.read<TokenState>().refresh();
      context.read<NotificationState>().refresh();
    }
  }

  /// In-app alert for socket `notification` events (FR-11).
  void _onNotification(IncomingNotification notification) {
    final tokenId = notification.tokenId;
    showAppMessage(
      notification.message,
      action: tokenId == null
          ? null
          : SnackBarAction(
              label: 'VIEW',
              onPressed: () => openTokenScreen(tokenId),
            ),
    );
  }

  Widget _body(int index) {
    switch (index) {
      case ShellState.findDoctor:
        return const BranchListView();
      case ShellState.appointments:
        return const AppointmentsScreen();
      case ShellState.history:
        return const HistoryScreen();
      case ShellState.profile:
        return const ProfileScreen();
      default:
        return const HomeScreen();
    }
  }

  @override
  Widget build(BuildContext context) {
    final shell = context.watch<ShellState>();
    final index = shell.index;
    return Scaffold(
      appBar: AppBar(
        title: Text(_titles[index]),
        actions: const [NotificationBell(), SizedBox(width: 4)],
      ),
      body: SafeArea(child: _body(index)),
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: shell.select,
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home),
            label: 'Home',
          ),
          NavigationDestination(
            icon: Icon(Icons.search),
            label: 'Find doctor',
          ),
          NavigationDestination(
            icon: Icon(Icons.event_outlined),
            selectedIcon: Icon(Icons.event),
            label: 'Appointments',
          ),
          NavigationDestination(
            icon: Icon(Icons.history),
            label: 'History',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: 'Profile',
          ),
        ],
      ),
    );
  }
}
