import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/launch/font_licenses.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the Licences page lists Manrope under its OFL text', () async {
    registerFontLicenses();

    final entries = await LicenseRegistry.licenses.toList();
    final manrope = entries.where(
      (entry) => entry.packages.contains('Manrope'),
    );

    expect(manrope, hasLength(1));
    final text = manrope.single.paragraphs.map((p) => p.text).join('\n');
    expect(text, contains('The Manrope Project Authors'));
    expect(text, contains('SIL OPEN FONT LICENSE Version 1.1'));
  });

  test('every font family the app bundles has a licence registered', () {
    // A font added to pubspec.yaml without its licence would ship unlisted.
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final families = RegExp(r'^\s+- family: (\S+)\s*$', multiLine: true)
        .allMatches(pubspec)
        .map((match) => match.group(1)!)
        .toSet();
    final licensed = bundledFontLicenses
        .map((license) => license.$1.replaceAll(' ', ''))
        .toSet();

    expect(families, isNotEmpty);
    expect(licensed, containsAll(families));
    for (final (_, asset) in bundledFontLicenses) {
      expect(pubspec, contains('- $asset'), reason: '$asset is bundled');
    }
  });
}
