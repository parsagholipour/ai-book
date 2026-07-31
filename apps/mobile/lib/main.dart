import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pdfrx/pdfrx.dart';

import 'app/app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // Loads the PDF rendering engine the in-app book reader draws with.
  pdfrxFlutterInitialize();
  runApp(const ProviderScope(child: TomezaApp()));
}
