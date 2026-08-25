import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/characters/presentation/character_avatar.dart';
import 'package:tomeza/features/characters/presentation/character_network_image.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/ui/authed_network_image.dart';

final _config = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('https://api.example.test'),
  privacyPolicyUrl: Uri.parse('https://example.test/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.test/terms'),
  accountDeletionUrl: Uri.parse('https://example.test/delete'),
  supportEmail: 'support@example.test',
);

void main() {
  testWidgets('CharacterAvatar explicitly busts cached mutable portraits', (
    tester,
  ) async {
    final updatedAt = DateTime.utc(2026, 8, 25, 12, 30);
    final character = LibraryCharacter(
      id: 'char-1',
      name: 'Mina Park',
      photoUrl: '/api/mobile/characters/char-1/photo?size=small',
      createdAt: DateTime.utc(2026, 8, 1),
      updatedAt: updatedAt,
    );

    await tester.pumpWidget(_app(CharacterAvatar(character: character)));
    await tester.pump();

    final shared = tester.widget<AuthedNetworkImage>(
      find.byType(AuthedNetworkImage),
    );
    expect(shared.cacheBuster, updatedAt.millisecondsSinceEpoch.toString());

    final uri = Uri.parse(_networkImage(tester).url);
    expect(uri.queryParameters['size'], 'small');
    expect(
      uri.queryParameters['v'],
      updatedAt.millisecondsSinceEpoch.toString(),
    );
  });

  testWidgets('CharacterNetworkImage never adds a cache buster', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const CharacterNetworkImage(
          url: '/api/mobile/characters/char-1/images/img-1?quality=full',
        ),
      ),
    );
    await tester.pump();

    final shared = tester.widget<AuthedNetworkImage>(
      find.byType(AuthedNetworkImage),
    );
    expect(shared.cacheBuster, isNull);

    final uri = Uri.parse(_networkImage(tester).url);
    expect(uri.queryParameters, {'quality': 'full'});
    expect(uri.queryParameters.containsKey('v'), isFalse);
  });
}

Widget _app(Widget child) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(_config),
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const {'Authorization': 'Bearer test-token'},
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
