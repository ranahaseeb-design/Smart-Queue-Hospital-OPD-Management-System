import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/app_notification.dart';
import '../navigation.dart';
import '../state/notification_state.dart';
import '../utils/errors.dart';
import '../utils/format.dart';
import '../widgets/async_views.dart';

/// In-app notifications (FR-11): token issued, turn approaching, called,
/// estimate changes. Unread items are highlighted and counted on the bell
/// badge until the patient taps "Mark all read". Items about a token open
/// its live view.
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  bool _marking = false;

  @override
  void initState() {
    super.initState();
    // Show the cached list at once and fetch anything newer.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _refresh();
    });
  }

  Future<void> _refresh() => context.read<NotificationState>().refresh();

  Future<void> _markAllRead() async {
    final state = context.read<NotificationState>();
    setState(() => _marking = true);
    try {
      await state.markAllRead();
    } catch (e) {
      showAppMessage(describeError(e), isError: true);
    } finally {
      if (mounted) setState(() => _marking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<NotificationState>();
    final unread = state.unreadCount;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          TextButton.icon(
            onPressed: unread == 0 || _marking ? null : _markAllRead,
            icon: const Icon(Icons.done_all),
            label: const Text('Mark all read'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(child: _buildBody(context, state)),
    );
  }

  Widget _buildBody(BuildContext context, NotificationState state) {
    if (!state.loaded) {
      final error = state.error;
      if (error == null) {
        return const LoadingView(message: 'Loading notifications…');
      }
      return RefreshIndicator(
        onRefresh: _refresh,
        child: ScrollableFill(
          child: ErrorView(message: error, onRetry: _refresh),
        ),
      );
    }
    if (state.items.isEmpty) {
      return RefreshIndicator(
        onRefresh: _refresh,
        child: const ScrollableFill(
          child: EmptyView(
            icon: Icons.notifications_none,
            title: 'No notifications yet',
            message: 'We will tell you here when your token is issued, when '
                'your turn is near and when you are called.',
          ),
        ),
      );
    }
    final unread = state.unreadCount;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 16),
        // One extra row on top for the unread summary.
        itemCount: state.items.length + 1,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          if (i == 0) return _UnreadSummary(unread: unread);
          return _NotificationTile(item: state.items[i - 1]);
        },
      ),
    );
  }
}

class _UnreadSummary extends StatelessWidget {
  const _UnreadSummary({required this.unread});

  final int unread;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = switch (unread) {
      0 => 'All caught up. Pull down to check for new messages.',
      1 => '1 unread notification',
      _ => '$unread unread notifications',
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
      child: Text(
        text,
        style: theme.textTheme.titleSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.item});

  final AppNotification item;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final tokenId = item.tokenId;
    final unread = !item.isRead;
    return Semantics(
      label: unread ? 'Unread' : null,
      child: ListTile(
        tileColor: unread ? scheme.primaryContainer : null,
        leading: Icon(
          unread ? Icons.notifications_active : Icons.notifications_none,
          color: unread ? scheme.primary : scheme.onSurfaceVariant,
          size: 30,
        ),
        title: Text(
          item.message,
          style: theme.textTheme.bodyLarge?.copyWith(
            fontWeight: unread ? FontWeight.w700 : FontWeight.w400,
          ),
        ),
        subtitle: Text(formatRelative(item.sentAt)),
        trailing: tokenId == null ? null : const Icon(Icons.chevron_right),
        onTap: tokenId == null ? null : () => openTokenScreen(tokenId),
      ),
    );
  }
}
