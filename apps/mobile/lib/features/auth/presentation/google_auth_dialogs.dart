import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import 'auth_legal_checks.dart';

Future<bool> confirmGoogleSignup(BuildContext context, AppConfig config) async {
  var terms = false;
  var age = false;
  return await showDialog<bool>(
        context: context,
        builder: (context) => StatefulBuilder(
          builder: (context, setState) => AlertDialog(
            title: const Text('Create your account'),
            content: SingleChildScrollView(
              child: AuthLegalAttestations(
                termsAccepted: terms,
                ageGuardianAttested: age,
                showError: false,
                enabled: true,
                onTermsChanged: (value) => setState(() => terms = value),
                onAgeGuardianChanged: (value) => setState(() => age = value),
                onOpenTerms: () =>
                    _openLegal(context, config.termsOfServiceUrl),
                onOpenPrivacy: () =>
                    _openLegal(context, config.privacyPolicyUrl),
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: terms && age
                    ? () => Navigator.pop(context, true)
                    : null,
                child: const Text('Create account'),
              ),
            ],
          ),
        ),
      ) ??
      false;
}

Future<void> _openLegal(BuildContext context, Uri uri) async {
  if (!await launchUrl(uri, mode: LaunchMode.externalApplication) &&
      context.mounted) {
    ScaffoldMessenger.of(context).showAppSnackBar(
      const SnackBar(content: Text('That legal page could not be opened.')),
    );
  }
}

Future<String?> confirmGoogleLink(BuildContext context, {String? error}) {
  return showDialog<String>(
    context: context,
    builder: (_) => _GoogleLinkDialog(error: error),
  );
}

class _GoogleLinkDialog extends StatefulWidget {
  const _GoogleLinkDialog({this.error});
  final String? error;

  @override
  State<_GoogleLinkDialog> createState() => _GoogleLinkDialogState();
}

class _GoogleLinkDialogState extends State<_GoogleLinkDialog> {
  final _password = TextEditingController();
  final _form = GlobalKey<FormState>();

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  void _submit() {
    if (_form.currentState!.validate()) Navigator.pop(context, _password.text);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Connect your Google account'),
    content: SingleChildScrollView(
      child: Form(
        key: _form,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'You already have a Tomeza account with this email. '
              'Confirm its password once to sign in with Google next time.',
            ),
            const SizedBox(height: 16),
            if (widget.error != null) ...[
              Text(
                widget.error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
              const SizedBox(height: 12),
            ],
            TextFormField(
              controller: _password,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              autofocus: true,
              decoration: const InputDecoration(labelText: 'Tomeza password'),
              textInputAction: TextInputAction.done,
              onFieldSubmitted: (_) => _submit(),
              validator: (value) => value == null || value.isEmpty
                  ? 'Enter your password.'
                  : null,
            ),
            const SizedBox(height: 12),
            const Text(
              'Forgot it? Cancel and use Forgot password on the sign-in screen.',
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: _submit,
        child: const Text('Connect and sign in'),
      ),
    ],
  );
}
