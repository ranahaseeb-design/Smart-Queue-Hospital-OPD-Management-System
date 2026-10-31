import 'package:flutter/foundation.dart';

/// Selected bottom-navigation tab of the patient home shell. Lets flows such
/// as "join queue" return the patient to Home after a token is issued.
class ShellState extends ChangeNotifier {
  static const int home = 0;
  static const int findDoctor = 1;
  static const int appointments = 2;
  static const int history = 3;
  static const int profile = 4;

  int _index = home;

  int get index => _index;

  void select(int index) {
    if (index == _index) return;
    _index = index;
    notifyListeners();
  }

  void reset() => select(home);
}
