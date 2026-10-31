import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app_theme.dart';
import 'navigation.dart';
import 'screens/home_shell.dart';
import 'screens/login_screen.dart';
import 'screens/splash_screen.dart';
import 'services/api_client.dart';
import 'services/auth_service.dart';
import 'services/location_service.dart';
import 'services/opd_api.dart';
import 'services/socket_service.dart';
import 'state/auth_state.dart';
import 'state/notification_state.dart';
import 'state/shell_state.dart';
import 'state/token_state.dart';

/// Smart OPD patient app (Section 4.2.1).
///
/// Wiring: one [ApiClient] (JWT + error parsing), a typed [OpdApi] over the
/// contract endpoints, one [SocketService] for live updates, and
/// ChangeNotifier states for the session, active tokens, notifications and
/// the selected tab.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final client = ApiClient();
  final api = OpdApi(client);
  final socket = SocketService();
  final auth = AuthState(
    client: client,
    api: api,
    storage: AuthService(),
    socket: socket,
  );
  runApp(SmartOpdApp(api: api, socket: socket, auth: auth));
  unawaited(auth.bootstrap());
}

class SmartOpdApp extends StatelessWidget {
  const SmartOpdApp({
    super.key,
    required this.api,
    required this.socket,
    required this.auth,
  });

  final OpdApi api;
  final SocketService socket;
  final AuthState auth;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        Provider<OpdApi>.value(value: api),
        Provider<SocketService>.value(value: socket),
        Provider<LocationService>(create: (_) => LocationService()),
        ChangeNotifierProvider<AuthState>.value(value: auth),
        ChangeNotifierProvider<TokenState>(
          create: (_) => TokenState(api, socket),
        ),
        ChangeNotifierProvider<NotificationState>(
          create: (_) => NotificationState(api, socket),
        ),
        ChangeNotifierProvider<ShellState>(create: (_) => ShellState()),
      ],
      child: MaterialApp(
        title: 'Smart OPD',
        debugShowCheckedModeBanner: false,
        theme: buildAppTheme(),
        themeMode: ThemeMode.light,
        navigatorKey: navigatorKey,
        scaffoldMessengerKey: scaffoldMessengerKey,
        home: const AuthGate(),
      ),
    );
  }
}

/// Routes by session state (FR-01): splash while restoring, login when
/// signed out, the patient home shell when signed in. Starts/stops the live
/// token and notification feeds with the session.
class AuthGate extends StatefulWidget {
  const AuthGate({super.key});

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  late final AuthState _auth;
  AuthStatus? _handled;

  @override
  void initState() {
    super.initState();
    _auth = context.read<AuthState>();
    _auth.addListener(_onAuthChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => _onAuthChanged());
  }

  @override
  void dispose() {
    _auth.removeListener(_onAuthChanged);
    super.dispose();
  }

  void _onAuthChanged() {
    if (!mounted) return;
    final status = _auth.status;
    if (status == _handled) return;
    _handled = status;

    final tokens = context.read<TokenState>();
    final notifications = context.read<NotificationState>();
    switch (status) {
      case AuthStatus.authenticated:
        tokens.start();
        notifications.start();
      case AuthStatus.unauthenticated:
        tokens.clear();
        notifications.clear();
        context.read<ShellState>().reset();
      case AuthStatus.unknown:
        break;
    }
    // Close anything pushed on top (the register screen after sign-up, or
    // a token screen when the session expired).
    navigatorKey.currentState?.popUntil((route) => route.isFirst);
  }

  @override
  Widget build(BuildContext context) {
    final status = context.select<AuthState, AuthStatus>((a) => a.status);
    return switch (status) {
      AuthStatus.unknown => const SplashScreen(),
      AuthStatus.unauthenticated => const LoginScreen(),
      AuthStatus.authenticated => const HomeShell(),
    };
  }
}
