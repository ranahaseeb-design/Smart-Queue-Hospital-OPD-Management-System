import 'dart:async';

import 'package:flutter/material.dart';

import 'screens/token_screen.dart';
import 'state/shell_state.dart';

/// App-wide navigator and messenger, so code that finishes after an `await`
/// (or a socket event) can navigate or show a message without holding on to
/// a possibly unmounted BuildContext.
final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();
final GlobalKey<ScaffoldMessengerState> scaffoldMessengerKey =
    GlobalKey<ScaffoldMessengerState>();

/// Shows a SnackBar. Messages stay a little longer than the default so that
/// elderly users have time to read them (NFR-03).
void showAppMessage(
  String message, {
  bool isError = false,
  SnackBarAction? action,
}) {
  final messenger = scaffoldMessengerKey.currentState;
  if (messenger == null) return;
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? const Color(0xFF8E0000) : null,
        duration: Duration(seconds: action == null ? 5 : 8),
        action: action,
      ),
    );
}

/// Pushes [screen] on the given context's navigator.
Future<T?> pushScreen<T>(BuildContext context, Widget screen) {
  return Navigator.of(context).push<T>(
    MaterialPageRoute<T>(builder: (_) => screen),
  );
}

/// Opens the live token screen from anywhere (notification tap, socket
/// event) without a BuildContext.
void openTokenScreen(int tokenId) {
  final navigator = navigatorKey.currentState;
  if (navigator == null) return;
  unawaited(navigator.push<void>(
    MaterialPageRoute<void>(builder: (_) => TokenScreen(tokenId: tokenId)),
  ));
}

/// After a token is issued (join queue, check-in, switch branch): return to
/// the Home tab and show the new token live, so the token is always the first
/// thing the patient sees (Section 4.12).
void openIssuedToken(ShellState shell, int tokenId) {
  shell.select(ShellState.home);
  final navigator = navigatorKey.currentState;
  if (navigator == null) return;
  navigator.popUntil((route) => route.isFirst);
  openTokenScreen(tokenId);
}
