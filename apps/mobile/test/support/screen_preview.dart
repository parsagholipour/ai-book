/// Renders a widget tree to a PNG so a UI change can be *looked at*, not just
/// asserted on.
///
/// `flutter test` draws every glyph with the Ahem box font, so this loads the
/// real Manrope and Material icon fonts first. Persian/Arabic text has no
/// fallback font here and renders as boxes; that is a limit of the harness, not
/// of the app.
///
/// Output goes to `build/previews/<name>.png` (gitignored). Open it with the
/// Read tool. Typical use, from a throwaway test under `test/_preview_<you>/`:
///
/// ```dart
/// testWidgets('preview', (tester) async {
///   await previewScreen(tester, name: 'home_light', app: MyScreenInApp());
/// });
/// ```
///
/// Delete the throwaway test when you are done; only this helper stays.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';

bool _fontsLoaded = false;

Future<void> loadPreviewFonts() async {
  if (_fontsLoaded) return;
  Future<ByteData> bytes(String path) async =>
      ByteData.sublistView(Uint8List.fromList(await File(path).readAsBytes()));

  final manrope = FontLoader('Manrope');
  for (final weight in ['Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold']) {
    manrope.addFont(bytes('assets/fonts/Manrope-$weight.ttf'));
  }
  await manrope.load();

  final flutterRoot = Platform.environment['FLUTTER_ROOT'];
  if (flutterRoot != null) {
    final icons = File(
      '$flutterRoot/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    );
    if (icons.existsSync()) {
      final loader = FontLoader('MaterialIcons')..addFont(bytes(icons.path));
      await loader.load();
    }
  }
  _fontsLoaded = true;
}

/// A [MaterialApp] wearing the real Tomeza theme, for wrapping a bare screen.
Widget previewApp(
  Widget home, {
  Brightness brightness = Brightness.light,
  double textScale = 1,
  TextDirection textDirection = TextDirection.ltr,
}) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildTomezaLightTheme(),
    darkTheme: buildTomezaDarkTheme(),
    themeMode: brightness == Brightness.dark ? ThemeMode.dark : ThemeMode.light,
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(textScaler: TextScaler.linear(textScale)),
      child: Directionality(textDirection: textDirection, child: child!),
    ),
    home: home,
  );
}

/// Pumps [app] at phone size, settles, and writes `build/previews/<name>.png`.
///
/// [app] must already contain its own `MaterialApp` and providers (use
/// [previewApp] for a bare screen). Pass [settle] = false for screens with an
/// endless animation, and pump the frames you want yourself through [beforeShot].
Future<File> previewScreen(
  WidgetTester tester, {
  required String name,
  required Widget app,
  Size size = const Size(390, 844),
  double pixelRatio = 2,
  bool settle = true,
  Future<void> Function()? beforeShot,
}) async {
  // Real file IO never completes inside a test's fake-async zone.
  await tester.runAsync(loadPreviewFonts);
  tester.view.physicalSize = size * pixelRatio;
  tester.view.devicePixelRatio = pixelRatio;
  addTearDown(tester.view.reset);

  // `flutter test` draws every elevation shadow as a hard black outline so
  // goldens stay deterministic; in a picture that reads as a dark ring around
  // every card and floating button. Draw the real, blurred shadow instead, and
  // put the flag back before the helper returns (the binding checks it when
  debugDisableShadows = false;
  final boundaryKey = GlobalKey();
  await tester.pumpWidget(RepaintBoundary(key: boundaryKey, child: app));
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump(const Duration(milliseconds: 400));
  }
  if (beforeShot != null) await beforeShot();

  final file = File('build/previews/$name.png');
  await tester.runAsync(() async {
    final boundary =
        boundaryKey.currentContext!.findRenderObject()!
            as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: pixelRatio);
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    await file.create(recursive: true);
    await file.writeAsBytes(png!.buffer.asUint8List());
  });
  debugDisableShadows = true;
  return file;
}
