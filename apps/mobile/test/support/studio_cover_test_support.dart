import 'dart:typed_data';

import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:image_picker/image_picker.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/media/photo_picker.dart';

import '../billing/billing_paywall_harness.dart';

// What a surface showing a Studio cover needs besides the Studio itself: a
// photo to pick, prices, a store for the paywall, and signed image headers.
// Kept apart from the Studio screen's harness so these suites do not compile
// the editor.

/// Hands back one picked photo (or nothing) and records what was asked.
class CoverTestPicker implements PhotoPicker {
  CoverTestPicker({this.result});

  XFile? result;
  final List<({ImageSource source, PhotoPickerPurpose purpose})> calls = [];

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    required PhotoPickerPurpose purpose,
  }) async {
    calls.add((source: source, purpose: purpose));
    return result;
  }
}

XFile coverTestPhoto() => XFile.fromData(
  Uint8List.fromList(List.filled(64, 7)),
  name: 'lighthouse.jpg',
  path: 'lighthouse.jpg',
  mimeType: 'image/jpeg',
);

final coverTestConfig = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://localhost:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete'),
  supportEmail: 'support@example.com',
);

/// The overrides a cover surface needs, with the doubles a test may want to
/// hold on to passed in.
List<Override> coverTestOverrides({
  PhotoPicker? picker,
  FakeBillingRepository? billing,
  FakeStoreBillingClient? store,
}) => [
  photoPickerProvider.overrideWithValue(
    picker ?? CoverTestPicker(result: coverTestPhoto()),
  ),
  billingRepositoryProvider.overrideWithValue(
    billing ?? FakeBillingRepository(),
  ),
  storeBillingClientProvider.overrideWithValue(
    store ?? FakeStoreBillingClient(),
  ),
  creditLogRepositoryProvider.overrideWithValue(EmptyCreditLogRepository()),
  appConfigProvider.overrideWithValue(coverTestConfig),
  apiAuthHeadersProvider.overrideWith((ref) async => const <String, String>{}),
];
