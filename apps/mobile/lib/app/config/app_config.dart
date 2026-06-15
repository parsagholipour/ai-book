import 'package:flutter_riverpod/flutter_riverpod.dart';

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
  const AppConfig({required this.environment, required this.apiBaseUrl});

  final AppEnvironment environment;
  final Uri apiBaseUrl;

  static AppConfig fromDartDefine() {
    const rawEnvironment = String.fromEnvironment(
      'APP_ENV',
      defaultValue: 'local',
    );
    const rawApiBaseUrl = String.fromEnvironment('API_BASE_URL');

    final environment = AppEnvironment.parse(rawEnvironment);
    final apiBaseUrl = rawApiBaseUrl.trim().isEmpty
        ? _defaultApiBaseUrl(environment)
        : Uri.parse(rawApiBaseUrl.trim());

    if (!apiBaseUrl.hasScheme || apiBaseUrl.host.isEmpty) {
      throw StateError('API_BASE_URL must be an absolute URL.');
    }

    if (environment != AppEnvironment.local && apiBaseUrl.scheme != 'https') {
      throw StateError(
        'Staging and production API_BASE_URL values must use HTTPS.',
      );
    }

    return AppConfig(environment: environment, apiBaseUrl: apiBaseUrl);
  }

  static Uri _defaultApiBaseUrl(AppEnvironment environment) {
    if (environment == AppEnvironment.local) {
      return Uri.parse('http://10.0.2.2:4001');
    }
    throw StateError('API_BASE_URL is required outside local builds.');
  }
}

final appConfigProvider = Provider<AppConfig>(
  (ref) => AppConfig.fromDartDefine(),
);
