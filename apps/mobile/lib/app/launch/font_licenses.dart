import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// The bundled fonts and the licence text each ships under.
///
/// Both are OFL-licensed, and the OFL asks that the licence travel with the
/// font. A font bundled as an asset is not seen by Flutter's licence
/// collector (that reads packages' LICENSE files), so without this the
/// Licences page listed neither.
const bundledFontLicenses = <(String family, String asset)>[
  ('Manrope', 'assets/fonts/OFL-Manrope.txt'),
  ('Noto Serif', 'assets/fonts/OFL-NotoSerif.txt'),
];

/// Adds [bundledFontLicenses] to the Licences page. The text is read only when
/// that page asks for it, so startup pays nothing for it.
void registerFontLicenses({AssetBundle? bundle}) {
  LicenseRegistry.addLicense(() => fontLicenseEntries(bundle: bundle));
}

Stream<LicenseEntry> fontLicenseEntries({AssetBundle? bundle}) async* {
  final assets = bundle ?? rootBundle;
  for (final (family, asset) in bundledFontLicenses) {
    final text = await assets.loadString(asset);
    yield LicenseEntryWithLineBreaks([family], text);
  }
}
