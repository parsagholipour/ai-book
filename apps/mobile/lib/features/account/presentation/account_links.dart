import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/ui/feedback/app_snack_bar.dart';

Future<void> openAccountUri(
  BuildContext context,
  Uri uri,
  String failedLaunchLabel,
) async {
  final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
  if (!opened && context.mounted) {
    ScaffoldMessenger.of(context).showAppSnackBar(
      SnackBar(content: Text('Could not open $failedLaunchLabel.')),
    );
  }
}

String formatAccountDate(BuildContext context, DateTime value) {
  return MaterialLocalizations.of(context).formatMediumDate(value.toLocal());
}
