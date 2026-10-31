import 'package:flutter/material.dart';

/// Teal seed colour shared with the hospital branding.
const Color kSeedColor = Color(0xFF00796B);

/// Minimum size for primary buttons: well above the 48dp accessibility
/// minimum so that elderly users can tap reliably (NFR-03).
const Size kLargeTarget = Size(64, 56);

/// Material 3 theme with larger text, large touch targets and high-contrast
/// colours (Section 4.12: "large touch targets and clear contrast for
/// elderly users").
ThemeData buildAppTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: kSeedColor);
  const buttonShape = RoundedRectangleBorder(
    borderRadius: BorderRadius.all(Radius.circular(14)),
  );
  const buttonText = TextStyle(fontSize: 17, fontWeight: FontWeight.w600);

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    // Explicit sizes are merged over the default typography, so every
    // screen reads a little larger than the Material defaults.
    textTheme: const TextTheme(
      headlineSmall: TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
      titleLarge: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
      titleMedium: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
      titleSmall: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      bodyLarge: TextStyle(fontSize: 18, height: 1.35),
      bodyMedium: TextStyle(fontSize: 16, height: 1.35),
      bodySmall: TextStyle(fontSize: 14, height: 1.3),
      labelLarge: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
      labelMedium: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: kLargeTarget,
        textStyle: buttonText,
        shape: buttonShape,
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        minimumSize: kLargeTarget,
        textStyle: buttonText,
        shape: buttonShape,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: kLargeTarget,
        textStyle: buttonText,
        shape: buttonShape,
        side: BorderSide(color: scheme.primary, width: 1.5),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        minimumSize: const Size(48, 48),
        textStyle: buttonText,
      ),
    ),
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(12)),
      ),
      contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 18),
    ),
    listTileTheme: const ListTileThemeData(
      minVerticalPadding: 12,
      contentPadding: EdgeInsets.symmetric(horizontal: 16),
    ),
    snackBarTheme: const SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      contentTextStyle: TextStyle(fontSize: 16, color: Colors.white),
    ),
    navigationBarTheme: NavigationBarThemeData(
      height: 72,
      indicatorColor: scheme.primaryContainer,
    ),
  );
}
