import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../navigation.dart';
import '../screens/notifications_screen.dart';
import '../state/notification_state.dart';

/// App-bar bell with the unread badge (FR-11).
class NotificationBell extends StatelessWidget {
  const NotificationBell({super.key});

  @override
  Widget build(BuildContext context) {
    final unread = context.select<NotificationState, int>((s) => s.unreadCount);
    return IconButton(
      tooltip: unread > 0
          ? 'Notifications, $unread unread'
          : 'Notifications',
      iconSize: 30,
      onPressed: () => pushScreen<void>(context, const NotificationsScreen()),
      icon: Badge(
        isLabelVisible: unread > 0,
        label: Text(unread > 99 ? '99+' : '$unread'),
        child: Icon(
          unread > 0 ? Icons.notifications_active : Icons.notifications_none,
        ),
      ),
    );
  }
}
