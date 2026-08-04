import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/config/app_config.dart';

/// Google Play's own subscription centre.
///
/// Changing or cancelling a real subscription happens there, not here: Google
/// requires it, and it is where the payment method already lives. Shared by the
/// Account screen and the cancel sheet so there is one link to keep correct.
Uri playSubscriptionsUrl(String? sku) {
  final query = <String>[
    if (sku != null) 'sku=$sku',
    'package=$androidPackageName',
  ].join('&');
  return Uri.parse('https://play.google.com/store/account/subscriptions?$query');
}

Future<bool> openPlaySubscriptions(String? sku) {
  return launchUrl(
    playSubscriptionsUrl(sku),
    mode: LaunchMode.externalApplication,
  );
}

/// The hand-off to Play, behind a provider so widget tests can stand in for it.
/// There is no url_launcher plugin under `flutter test`: the channel call never
/// answers, so a test that let this run would hang rather than fail.
final playSubscriptionsLauncherProvider =
    Provider<Future<bool> Function(String? sku)>((ref) {
      return openPlaySubscriptions;
    });
