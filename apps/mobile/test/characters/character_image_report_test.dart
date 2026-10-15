import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_image_models.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/characters/presentation/character_profile_screen.dart';
import 'package:tomeza/features/projects/presentation/ai_content_report.dart';
import 'package:tomeza/features/projects/presentation/book_preview_section.dart';
import 'package:tomeza/shared/api/api_client.dart';

import 'character_test_support.dart';

/// A drawn picture of a saved character is AI output, so Google Play's
/// generative-AI policy wants it reportable where it is shown. An upload — a
/// photo, or the reader's own drawing adopted as it stands — is theirs.

class _RecordingApi implements ApiClient {
  final List<({String path, Object? data})> posts = [];

  @override
  Future<Map<String, dynamic>> postMap(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) async {
    posts.add((path: path, data: data));
    return {
      'report': {'id': 'report-1', 'status': 'pending'},
    };
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  Future<_RecordingApi> pumpProfile(
    WidgetTester tester, {
    required List<CharacterImage> images,
  }) async {
    final api = _RecordingApi();
    final repository = FakeCharactersRepository(
      testCharacter(
        portraitStatus: CharacterPortraitStatus.ready,
        portraitSource: CharacterPortraitSource.generated,
      ),
      images: images,
    );
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiAuthHeadersProvider.overrideWith(
            (ref) async => const <String, String>{},
          ),
          charactersRepositoryProvider.overrideWithValue(repository),
          aiContentReportsApiProvider.overrideWithValue(
            AiContentReportsApi(api),
          ),
        ],
        child: const MaterialApp(
          home: CharacterProfileScreen(characterId: 'char-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return api;
  }

  Finder tileFor(String imageId) =>
      find.byKey(ValueKey('character-image-tile-$imageId'));

  testWidgets('a drawn picture can be reported from its menu', (tester) async {
    final api = await pumpProfile(
      tester,
      images: [
        testImage(id: 'img-drawn', isMain: true, isCurrentReference: true),
      ],
    );

    await tester.longPress(tileFor('img-drawn'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('character-image-report')));
    await tester.pumpAndSettle();

    expect(find.byType(ContentReportDialog), findsOneWidget);
    expect(find.text('Report this AI-drawn picture'), findsOneWidget);
    await tester.tap(find.text('Send report'));
    await tester.pumpAndSettle();

    expect(
      api.posts.single.path,
      '/api/mobile/characters/char-1/images/img-drawn/reports',
    );
    expect(api.posts.single.data, {'reason': 'other'});
    expect(find.text('Report sent for review.'), findsOneWidget);
  });

  for (final kind in [
    CharacterPhotoKind.photograph,
    CharacterPhotoKind.illustration,
  ]) {
    testWidgets('an uploaded ${kind.name} offers no Report', (tester) async {
      await pumpProfile(
        tester,
        images: [
          testImage(id: 'img-drawn', isMain: true, isCurrentReference: true),
          testImage(
            id: 'img-upload',
            source: CharacterImageSource.upload,
            photoKind: kind,
          ),
        ],
      );

      await tester.longPress(tileFor('img-upload'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('character-image-share')), findsOne);
      expect(
        find.byKey(const ValueKey('character-image-report')),
        findsNothing,
      );
    });
  }
}
