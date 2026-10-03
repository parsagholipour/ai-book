import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Must match `applicationId` in `android/app/build.gradle.kts`. Needed to deep
/// link into this app's Play subscription settings.
const androidPackageName = 'com.tomeza.tomeza';

/// Where the production API lives — the default for a release build that was
/// not told otherwise (`docs/deployment.md`).
const productionApiBaseUrl = 'https://tomeza.ravanix.app';

/// True in a release (`--release`) build. The dart-define defaults below read
/// it so a release built without flags talks to production rather than to the
/// emulator host with a fake store, which a single forgotten flag used to ship.
const _isReleaseBuild = bool.fromEnvironment('dart.vm.product');

enum AppEnvironment {
  local,
  staging,
  production;

  static AppEnvironment parse(String value) {
    return switch (value.trim().toLowerCase()) {
      'staging' => AppEnvironment.staging,
      'production' => AppEnvironment.production,
      _ => AppEnvironment.local,
    };
  }
}

class AppConfig {
  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.privacyPolicyUrl,
    required this.termsOfServiceUrl,
    required this.accountDeletionUrl,
    required this.supportEmail,
  });

  final AppEnvironment environment;
  final Uri apiBaseUrl;
  final Uri privacyPolicyUrl;
  final Uri termsOfServiceUrl;
  final Uri accountDeletionUrl;
  final String supportEmail;

  static AppConfig fromDartDefine() {
    const rawEnvironment = String.fromEnvironment(
      'APP_ENV',
      defaultValue: _isReleaseBuild ? 'production' : 'local',
    );
    const rawApiBaseUrl = String.fromEnvironment('API_BASE_URL');
    const rawPrivacyPolicyUrl = String.fromEnvironment(
      'PRIVACY_POLICY_URL',
      defaultValue: 'https://tomeza.ravanix.app/privacy',
    );
    const rawTermsOfServiceUrl = String.fromEnvironment(
      'TERMS_OF_SERVICE_URL',
      defaultValue: 'https://tomeza.ravanix.app/terms',
    );
    const rawAccountDeletionUrl = String.fromEnvironment(
      'ACCOUNT_DELETION_URL',
      defaultValue: 'https://tomeza.ravanix.app/account-deletion',
    );
    const rawSupportEmail = String.fromEnvironment(
      'SUPPORT_EMAIL',
      defaultValue: 'support@ravanix.app',
    );

    final environment = AppEnvironment.parse(rawEnvironment);
    final apiBaseUrl = rawApiBaseUrl.trim().isEmpty
        ? _defaultApiBaseUrl(environment)
        : Uri.parse(rawApiBaseUrl.trim());
    final privacyPolicyUrl = Uri.parse(rawPrivacyPolicyUrl.trim());
    final termsOfServiceUrl = Uri.parse(rawTermsOfServiceUrl.trim());
    final accountDeletionUrl = Uri.parse(rawAccountDeletionUrl.trim());

    if (!apiBaseUrl.hasScheme || apiBaseUrl.host.isEmpty) {
      throw StateError('API_BASE_URL must be an absolute URL.');
    }
    for (final url in [
      privacyPolicyUrl,
      termsOfServiceUrl,
      accountDeletionUrl,
    ]) {
      if (!url.hasScheme || url.host.isEmpty) {
        throw StateError('Policy and account deletion URLs must be absolute.');
      }
    }

    if (environment != AppEnvironment.local && apiBaseUrl.scheme != 'https') {
      throw StateError(
        'Staging and production API_BASE_URL values must use HTTPS.',
      );
    }

    return AppConfig(
      environment: environment,
      apiBaseUrl: apiBaseUrl,
      privacyPolicyUrl: privacyPolicyUrl,
      termsOfServiceUrl: termsOfServiceUrl,
      accountDeletionUrl: accountDeletionUrl,
      supportEmail: rawSupportEmail.trim().isEmpty
          ? 'support@ravanix.app'
          : rawSupportEmail.trim(),
    );
  }

  static Uri _defaultApiBaseUrl(AppEnvironment environment) {
    return switch (environment) {
      AppEnvironment.local => Uri.parse('http://10.0.2.2:4001'),
      AppEnvironment.production => Uri.parse(productionApiBaseUrl),
      AppEnvironment.staging => throw StateError(
        'API_BASE_URL is required for staging builds.',
      ),
    };
  }
}

final appConfigProvider = Provider<AppConfig>(
  (ref) => AppConfig.fromDartDefine(),
);
