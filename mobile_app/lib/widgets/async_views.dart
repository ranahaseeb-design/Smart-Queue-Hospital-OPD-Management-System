import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../navigation.dart';
import '../utils/errors.dart';

/// Full-area loading indicator with an optional caption.
class LoadingView extends StatelessWidget {
  const LoadingView({super.key, this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    final text = message;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 44,
              height: 44,
              child: CircularProgressIndicator(strokeWidth: 4),
            ),
            if (text != null) ...[
              const SizedBox(height: 16),
              Text(
                text,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Error message with a large "Try again" button.
class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final retry = onRetry;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.cloud_off, size: 56, color: theme.colorScheme.error),
        const SizedBox(height: 12),
        Text(
          message,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyLarge,
        ),
        if (retry != null) ...[
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: retry,
            icon: const Icon(Icons.refresh),
            label: const Text('Try again'),
          ),
        ],
      ],
    );
  }
}

/// Friendly empty state with an optional call to action.
class EmptyView extends StatelessWidget {
  const EmptyView({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = message;
    final cta = action;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 64, color: theme.colorScheme.primary),
        const SizedBox(height: 12),
        Text(
          title,
          textAlign: TextAlign.center,
          style: theme.textTheme.titleLarge,
        ),
        if (text != null) ...[
          const SizedBox(height: 8),
          Text(
            text,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyLarge,
          ),
        ],
        if (cta != null) ...[const SizedBox(height: 20), cta],
      ],
    );
  }
}

/// Centres [child] in a scrollable that always scrolls, so pull-to-refresh
/// also works on empty and error states.
class ScrollableFill extends StatelessWidget {
  const ScrollableFill({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final minHeight = constraints.hasBoundedHeight
            ? math.max(0.0, constraints.maxHeight - 48)
            : 0.0;
        return SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: minHeight),
            child: Center(child: child),
          ),
        );
      },
    );
  }
}

typedef ReloadCallback = Future<void> Function();

/// Loads data once, then shows it with pull-to-refresh; handles the loading,
/// error (with retry) and empty states the same way on every screen.
///
/// [builder] must return a scrollable (e.g. a ListView with
/// AlwaysScrollableScrollPhysics) so that pull-to-refresh works.
class AsyncLoader<T> extends StatefulWidget {
  const AsyncLoader({
    super.key,
    required this.load,
    required this.builder,
    this.isEmpty,
    this.emptyBuilder,
    this.loadingMessage,
  });

  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data, ReloadCallback reload)
      builder;
  final bool Function(T data)? isEmpty;
  final Widget Function(BuildContext context, ReloadCallback reload)?
      emptyBuilder;
  final String? loadingMessage;

  @override
  State<AsyncLoader<T>> createState() => _AsyncLoaderState<T>();
}

class _AsyncLoaderState<T> extends State<AsyncLoader<T>> {
  T? _data;
  bool _hasData = false;
  bool _loading = true;
  String? _error;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (!mounted) return;
    final generation = ++_generation;
    if (!_loading) setState(() => _loading = true);
    try {
      final data = await widget.load();
      if (!mounted || generation != _generation) return;
      setState(() {
        _data = data;
        _hasData = true;
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted || generation != _generation) return;
      final message = describeError(e);
      setState(() {
        _error = message;
        _loading = false;
      });
      // Keep showing the last good data; just tell the patient.
      if (_hasData) showAppMessage(message, isError: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_hasData) {
      if (_loading) return LoadingView(message: widget.loadingMessage);
      return RefreshIndicator(
        onRefresh: _load,
        child: ScrollableFill(
          child: ErrorView(
            message: _error ?? 'Something went wrong. Please try again.',
            onRetry: _load,
          ),
        ),
      );
    }
    final data = _data as T;
    final isEmpty = widget.isEmpty;
    final emptyBuilder = widget.emptyBuilder;
    if (isEmpty != null && emptyBuilder != null && isEmpty(data)) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ScrollableFill(child: emptyBuilder(context, _load)),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: widget.builder(context, data, _load),
    );
  }
}
