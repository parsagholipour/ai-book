import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'launch_screen.dart';

/// Paint the launch page before initializing platform services. The routed
/// app (and its audio players) is mounted only after those services are ready.
class AppStartup<T extends Object> extends StatefulWidget {
  const AppStartup({
    required this.initialize,
    required this.builder,
    super.key,
  });

  final Future<T> Function() initialize;
  final Widget Function(T services, String? initialLocation) builder;

  @override
  State<AppStartup<T>> createState() => _AppStartupState<T>();
}

class _AppStartupState<T extends Object> extends State<AppStartup<T>>
    with WidgetsBindingObserver {
  late final Future<T> _services;
  String? _pendingLocation;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _services = _initialize();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Future<bool> didPushRouteInformation(
    RouteInformation routeInformation,
  ) async {
    if (_ready) return false;
    // A cold-start link can arrive after the first frame, while the platform
    // services are still loading. Let the real router open it when ready.
    _pendingLocation = routeInformation.uri.toString();
    return true;
  }

  Future<T> _initialize() async {
    await WidgetsBinding.instance.endOfFrame;
    try {
      return await widget.initialize();
    } catch (error, stack) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          stack: stack,
          library: 'Tomeza startup',
          context: ErrorDescription('while initializing the app'),
        ),
      );
      rethrow;
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _services,
      builder: (context, snapshot) {
        if (snapshot.hasData) {
          _ready = true;
          return widget.builder(snapshot.requireData, _pendingLocation);
        }
        return MaterialApp(
          title: 'Tomeza',
          debugShowCheckedModeBanner: false,
          theme: buildTomezaLightTheme(),
          darkTheme: buildTomezaDarkTheme(),
          // The real router handles the platform's initial route after boot.
          initialRoute: '/',
          home: LaunchScreen(
            loadingMessage: 'Opening Tomeza',
            slowMessage: 'Still getting ready. Thanks for your patience.',
            errorTitle: 'Couldn’t start Tomeza',
            // Platform initialization cannot safely be repeated in-process.
            errorMessage: snapshot.hasError
                ? 'Please close the app and open it again.'
                : null,
          ),
        );
      },
    );
  }
}
