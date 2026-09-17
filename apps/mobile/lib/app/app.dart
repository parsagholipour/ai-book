import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/account/data/appearance_store.dart';
import '../features/account/domain/appearance_prefs.dart';
import 'routing/app_router.dart';
import 'theme/app_theme.dart';

class TomezaApp extends ConsumerWidget {
  const TomezaApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    final appearance = ref.watch(appearanceModeProvider);

    return MaterialApp.router(
      title: 'Tomeza',
      debugShowCheckedModeBanner: false,
      theme: buildTomezaLightTheme(),
      darkTheme: buildTomezaDarkTheme(),
      themeMode: appearance.value == null
          ? ThemeMode.system
          : _themeModeFor(appearance.value!),
      // Spelled out rather than `routerConfig: router` so the back button can go
      // through `appBackButtonDispatcherProvider`; the other three are exactly
      // what `routerConfig` would have supplied.
      routerDelegate: router.routerDelegate,
      routeInformationParser: router.routeInformationParser,
      routeInformationProvider: router.routeInformationProvider,
      backButtonDispatcher: ref.watch(appBackButtonDispatcherProvider),
    );
  }
}

ThemeMode _themeModeFor(AppearanceMode mode) => switch (mode) {
  AppearanceMode.system => ThemeMode.system,
  AppearanceMode.light => ThemeMode.light,
  AppearanceMode.dark => ThemeMode.dark,
};
