import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/ui/authed_network_image.dart';

final _config = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('https://api.example.test/root/'),
  privacyPolicyUrl: Uri.parse('https://example.test/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.test/terms'),
  accountDeletionUrl: Uri.parse('https://example.test/delete'),
  supportEmail: 'support@example.test',
);

void main() {
  testWidgets('resolves API-relative URLs and preserves their existing query', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const AuthedNetworkImage(
          url: '/images/cover.png?size=small&format=webp',
          cacheBuster: 'revision-7',
        ),
      ),
    );
    await tester.pump();

    final network = _networkImage(tester);
    final uri = Uri.parse(network.url);
    expect(uri.origin, 'https://api.example.test');
    expect(uri.path, '/images/cover.png');
    expect(uri.queryParameters, {
      'size': 'small',
      'format': 'webp',
      'v': 'revision-7',
    });
    expect(network.headers, const {'Authorization': 'Bearer test-token'});
  });

  testWidgets('keeps an absolute immutable URL unchanged', (tester) async {
    const url = 'https://cdn.example.test/picture.jpg?quality=80';
    await tester.pumpWidget(
      _app(const AuthedNetworkImage(url: url, cacheBuster: null)),
    );
    await tester.pump();

    expect(_networkImage(tester).url, url);
  });

  testWidgets('shows auth loading and auth error placeholders', (tester) async {
    final headers = Completer<Map<String, String>>();
    await tester.pumpWidget(
      _app(
        const AuthedNetworkImage(
          url: '/picture.jpg',
          cacheBuster: null,
          loadingPlaceholder: Text('waiting for auth'),
          errorPlaceholder: Text('auth failed'),
        ),
        headers: headers.future,
      ),
    );

    expect(find.text('waiting for auth'), findsOneWidget);
    expect(find.text('auth failed'), findsNothing);

    headers.completeError(StateError('signed out'));
    await tester.pump();
    await tester.pump();

    expect(find.text('waiting for auth'), findsNothing);
    expect(find.text('auth failed'), findsOneWidget);
  });

  testWidgets('converts logical decode width to physical cache width', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      _app(
        const AuthedNetworkImage(
          url: '/picture.jpg',
          cacheBuster: null,
          logicalDecodeWidth: 40,
        ),
      ),
    );
    await tester.pump();

    final image = tester.widget<Image>(find.byType(Image));
    expect(image.image, isA<ResizeImage>());
    expect((image.image as ResizeImage).width, 110);
  });
}

Widget _app(Widget child, {Future<Map<String, String>>? headers}) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(_config),
      apiAuthHeadersProvider.overrideWith(
        (ref) =>
            headers ??
            Future.value(const {'Authorization': 'Bearer test-token'}),
      ),
    ],
    child: MaterialApp(home: Scaffold(body: child)),
  );
}

NetworkImage _networkImage(WidgetTester tester) {
  final image = tester.widget<Image>(find.byType(Image));
  final provider = image.image;
  return switch (provider) {
    final ResizeImage resized => resized.imageProvider as NetworkImage,
    final NetworkImage network => network,
    _ => throw TestFailure('Expected a NetworkImage, got $provider'),
  };
}
