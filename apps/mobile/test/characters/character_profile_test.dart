import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_image_models.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/characters/presentation/character_profile_screen.dart';

import 'character_test_support.dart';

/// The character's own page: what a book will do with their picture, and every
/// picture they have ever had.
///
/// The copy assertions here moved off the editor sheet unchanged — the words
/// are the contract, not the widget that happened to hold them.
void main() {
  Finder tileFor(String imageId) =>
      find.byKey(ValueKey('character-image-tile-$imageId'));

  Future<FakeCharactersRepository> pumpProfile(
    WidgetTester tester,
    LibraryCharacter saved, {
    List<CharacterImage> images = const [],
    List<LibraryCharacter>? libraryCharacters,
    // A character mid-drawing never settles: the poll is a periodic timer and
    // the card carries an indeterminate progress bar.
    bool settle = true,
  }) async {
    final repository = FakeCharactersRepository(
      saved,
      images: images,
      libraryCharacters: libraryCharacters,
    );
    // Tall enough that every sliver builds: the strip is the last one, and a
    // lazy sliver below the fold is not in the tree to be found.
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [charactersRepositoryProvider.overrideWithValue(repository)],
        child: MaterialApp(home: CharacterProfileScreen(characterId: saved.id)),
      ),
    );
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      await tester.pump();
      await tester.pump();
    }
    return repository;
  }

  group('what a book will do with the picture', () {
    testWidgets('a stored photo says the books cannot draw from it yet', (
      tester,
    ) async {
      await pumpProfile(
        tester,
        testCharacter(photoKind: CharacterPhotoKind.photograph),
      );

      expect(
        find.textContaining('cannot draw from this image yet'),
        findsOneWidget,
      );
      // The one action that changes that leads, and quotes its price.
      expect(
        find.widgetWithText(
          FilledButton,
          'Make illustrated version (45 credits)',
        ),
        findsOneWidget,
      );
    });

    // No vision provider, a timeout, or an honest "unsure": the server made no
    // claim about the image, so neither may the page.
    for (final kind in <CharacterPhotoKind?>[
      null,
      CharacterPhotoKind.unknown,
    ]) {
      testWidgets('a ${kind?.name ?? "never read"} photo is not called real', (
        tester,
      ) async {
        await pumpProfile(tester, testCharacter(photoKind: kind));

        expect(find.textContaining('real photo'), findsNothing);
        expect(
          find.textContaining('cannot draw from this image yet'),
          findsOneWidget,
        );
      });
    }

    testWidgets(
      'a portrait drawn from a description alone is not "add a photo"',
      (tester) async {
        await pumpProfile(
          tester,
          testCharacter(
            hasPhoto: false,
            portraitStatus: CharacterPortraitStatus.ready,
            portraitSource: CharacterPortraitSource.generated,
            usedInBooks: true,
          ),
        );

        expect(find.textContaining('Add a photo or a drawing'), findsNothing);
        expect(
          find.textContaining(
            'draw this character from the illustrated version',
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('adopted artwork already is the character', (tester) async {
      await pumpProfile(
        tester,
        testCharacter(
          photoKind: CharacterPhotoKind.illustration,
          portraitSource: CharacterPortraitSource.adoptedUpload,
          portraitStatus: CharacterPortraitStatus.ready,
          usedInBooks: true,
        ),
      );

      expect(
        find.textContaining('Your artwork is this character'),
        findsOneWidget,
      );
      expect(find.textContaining('cannot draw from it yet'), findsNothing);
      // Redrawing is offered, but demoted: nothing is owed.
      expect(
        find.widgetWithText(
          FilledButton,
          'Make illustrated version (45 credits)',
        ),
        findsNothing,
      );
      expect(find.textContaining('Redraw illustration'), findsOneWidget);
    });

    testWidgets('says what the illustrated version is for', (tester) async {
      await pumpProfile(
        tester,
        testCharacter(photoKind: CharacterPhotoKind.photograph),
      );

      expect(
        find.textContaining(
          'Your books illustrate every picture of this character from it',
        ),
        findsOneWidget,
      );
    });

    testWidgets('a redraw says which books it reaches', (tester) async {
      await pumpProfile(
        tester,
        testCharacter(
          portraitStatus: CharacterPortraitStatus.ready,
          portraitSource: CharacterPortraitSource.generated,
          usedInBooks: true,
        ),
      );

      expect(
        find.textContaining('the ones you have already made keep their look'),
        findsOneWidget,
      );
    });

    testWidgets('a drawing the reader owns is offered free, not for 45', (
      tester,
    ) async {
      // Artwork the server judged promotable is one free tap from being what
      // books draw. Quoting a redraw as the only way forward would sell them
      // something they already have.
      await pumpProfile(
        tester,
        testCharacter(photoKind: CharacterPhotoKind.illustration),
        images: [
          testImage(
            id: 'img-art',
            source: CharacterImageSource.upload,
            photoKind: CharacterPhotoKind.illustration,
            isCurrentPhoto: true,
            isMain: true,
            canBeMain: true,
          ),
        ],
      );

      expect(
        find.byKey(const ValueKey('character-use-this-drawing')),
        findsOneWidget,
      );
    });

    testWidgets('a failed drawing says the credits came back', (tester) async {
      await pumpProfile(
        tester,
        testCharacter(portraitStatus: CharacterPortraitStatus.failed),
      );

      expect(find.text('Illustration failed'), findsOneWidget);
      expect(find.textContaining('credits were refunded'), findsOneWidget);
    });
  });

  group('the picture history', () {
    testWidgets('shows every retained picture with the main one marked', (
      tester,
    ) async {
      await pumpProfile(
        tester,
        testCharacter(
          portraitStatus: CharacterPortraitStatus.ready,
          portraitSource: CharacterPortraitSource.generated,
          usedInBooks: true,
        ),
        images: [
          testImage(id: 'img-new', isMain: true, isCurrentReference: true),
          testImage(id: 'img-old', canBeMain: true),
          testImage(
            id: 'img-photo',
            source: CharacterImageSource.upload,
            photoKind: CharacterPhotoKind.photograph,
            isCurrentPhoto: true,
          ),
        ],
      );

      expect(find.text('Pictures'), findsOneWidget);
      expect(find.textContaining('The last 20 are kept'), findsOneWidget);
      expect(tileFor('img-new'), findsOneWidget);
      expect(tileFor('img-old'), findsOneWidget);
      expect(tileFor('img-photo'), findsOneWidget);

      // Nothing inside a tile is text — the row's height is fixed, and a label
      // in there would reflow it at a 1.6 text scale — so every word a reader
      // needs is in the semantics instead.
      final semantics = tester.ensureSemantics();
      expect(
        find.bySemanticsLabel(RegExp('AI illustration, 1 of 3, main picture')),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel(RegExp('Your photo, 3 of 3')),
        findsOneWidget,
      );
      semantics.dispose();
    });

    testWidgets('an empty history asks for a picture instead of a bare rail', (
      tester,
    ) async {
      await pumpProfile(tester, testCharacter(hasPhoto: false));

      expect(find.text('Add a photo, or have one drawn.'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('character-strip-add-tile')),
        findsOneWidget,
      );
    });

    testWidgets('the Pictures heading sits on the same gutter as About', (
      tester,
    ) async {
      await pumpProfile(
        tester,
        testCharacter(
          portraitStatus: CharacterPortraitStatus.ready,
          portraitSource: CharacterPortraitSource.generated,
        ),
        images: [
          testImage(id: 'img-new', isMain: true, isCurrentReference: true),
        ],
      );

      expect(
        tester.getTopLeft(find.text('Pictures')).dx,
        tester.getTopLeft(find.text('About')).dx,
      );
      expect(
        tester.getTopLeft(find.text('Hold a picture for more.')).dx,
        tester.getTopLeft(find.text('About')).dx,
      );
    });

    testWidgets('holding a picture promotes it, and says what changed', (
      tester,
    ) async {
      final repository = await pumpProfile(
        tester,
        testCharacter(
          portraitStatus: CharacterPortraitStatus.ready,
          portraitSource: CharacterPortraitSource.generated,
          usedInBooks: true,
        ),
        images: [
          testImage(id: 'img-new', isMain: true, isCurrentReference: true),
          testImage(id: 'img-old', canBeMain: true),
        ],
      );

      await tester.longPress(tileFor('img-old'));
      await tester.pumpAndSettle();
      expect(find.text('Make this the main picture'), findsOneWidget);
      // Only this action may promise a book behaviour.
      expect(
        find.text('Your books will draw this character from it.'),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('character-image-promote')));
      await tester.pumpAndSettle();

      expect(repository.promoted, ['img-old']);
      expect(
        find.textContaining('New books will draw Mina Park from it'),
        findsOneWidget,
      );
    });

    testWidgets('a photograph is never offered a book promise', (tester) async {
      // The whole point of the photo/illustration split: a book cannot draw
      // from a photograph, so nothing may say it will.
      await pumpProfile(
        tester,
        testCharacter(
          hasPhoto: false,
          portraitStatus: CharacterPortraitStatus.ready,
          portraitSource: CharacterPortraitSource.generated,
          usedInBooks: true,
        ),
        images: [
          testImage(id: 'img-new', isMain: true, isCurrentReference: true),
          testImage(
            id: 'img-photo',
            source: CharacterImageSource.upload,
            photoKind: CharacterPhotoKind.photograph,
          ),
        ],
      );

      await tester.longPress(tileFor('img-photo'));
      await tester.pumpAndSettle();

      expect(find.text('Make this the main picture'), findsNothing);
      expect(
        find.text('Your books will draw this character from it.'),
        findsNothing,
      );
    });

    testWidgets('deleting the main picture promises the previous one back', (
      tester,
    ) async {
      final repository = await pumpProfile(
        tester,
        testCharacter(
          portraitStatus: CharacterPortraitStatus.ready,
          portraitSource: CharacterPortraitSource.generated,
          usedInBooks: true,
        ),
        images: [
          testImage(id: 'img-new', isMain: true, isCurrentReference: true),
          testImage(id: 'img-old', canBeMain: true),
        ],
      );

      await tester.longPress(tileFor('img-new'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('puts the previous illustration back'),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('character-image-delete')));
      await tester.pumpAndSettle();
      // Delete is the one action here that asks first.
      expect(find.text('Delete this picture?'), findsOneWidget);
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();

      expect(repository.deletedImages, ['img-new']);
    });

    testWidgets('deleting the last usable picture says so instead', (
      tester,
    ) async {
      await pumpProfile(
        tester,
        testCharacter(
          portraitStatus: CharacterPortraitStatus.ready,
          portraitSource: CharacterPortraitSource.generated,
          usedInBooks: true,
        ),
        images: [
          testImage(id: 'img-only', isMain: true, isCurrentReference: true),
        ],
      );

      await tester.longPress(tileFor('img-only'));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('new books invent their look again'),
        findsOneWidget,
      );
      expect(
        find.textContaining('puts the previous illustration back'),
        findsNothing,
      );
    });

    testWidgets('deleting an older picture says nothing else changes', (
      tester,
    ) async {
      await pumpProfile(
        tester,
        testCharacter(
          portraitStatus: CharacterPortraitStatus.ready,
          portraitSource: CharacterPortraitSource.generated,
          usedInBooks: true,
        ),
        images: [
          testImage(id: 'img-new', isMain: true, isCurrentReference: true),
          testImage(id: 'img-old', canBeMain: true),
        ],
      );

      await tester.longPress(tileFor('img-old'));
      await tester.pumpAndSettle();

      expect(
        find.text(
          'This is not what your books draw from, so nothing else changes.',
        ),
        findsOneWidget,
      );
    });
  });

  group('linked descriptions', () {
    testWidgets('a saved @mention opens the linked character profile', (
      tester,
    ) async {
      final bram = testCharacter(id: 'char-2', name: 'Bram');
      final mina = testCharacter(
        description: 'Best friends with @Bram.',
        mentions: const [LibraryMention(id: 'char-2', name: 'Bram')],
      );
      await pumpProfile(tester, mina, libraryCharacters: [mina, bram]);

      expect(
        find.byKey(const ValueKey('character-linked-description')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('character-mention-char-2')));
      await tester.pumpAndSettle();
      expect(find.text('Bram'), findsWidgets);
    });

    testWidgets(
      'a mention of something that is not a character is not a link',
      (tester) async {
        // No server emits a location row yet — one has no name to print — but
        // this build will still be installed when the first one does, and
        // drawing it as a character link is a tap that resolves to nobody.
        final mina = testCharacter(
          description: 'Grew up in @Thornwood.',
          mentions: const [
            LibraryMention(
              id: 'loc-1',
              name: 'Thornwood',
              kind: LibraryMentionKind.location,
            ),
          ],
        );
        await pumpProfile(tester, mina);

        expect(
          find.byKey(const ValueKey('character-linked-description')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('character-mention-loc-1')),
          findsNothing,
        );
      },
    );

    testWidgets('an unlinked @name remains ordinary prose', (tester) async {
      await pumpProfile(tester, testCharacter(description: 'Once knew @Bram.'));

      expect(
        find.byKey(const ValueKey('character-linked-description')),
        findsNothing,
      );
      expect(find.text('Once knew @Bram.'), findsOneWidget);
    });

    testWidgets('linked profiles can be followed through nested navigation', (
      tester,
    ) async {
      final cora = testCharacter(id: 'char-3', name: 'Cora');
      final bram = testCharacter(
        id: 'char-2',
        name: 'Bram',
        description: 'Trusts @Cora.',
        mentions: const [LibraryMention(id: 'char-3', name: 'Cora')],
      );
      final mina = testCharacter(
        description: 'Best friends with @Bram.',
        mentions: const [LibraryMention(id: 'char-2', name: 'Bram')],
      );
      await pumpProfile(tester, mina, libraryCharacters: [mina, bram, cora]);

      await tester.tap(find.byKey(const ValueKey('character-mention-char-2')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('character-mention-char-3')));
      await tester.pumpAndSettle();

      expect(find.text('Cora'), findsWidgets);
    });
  });

  group('the redraw asks first', () {
    LibraryCharacter drawn() => testCharacter(
      portraitStatus: CharacterPortraitStatus.ready,
      portraitSource: CharacterPortraitSource.generated,
      usedInBooks: true,
    );

    Finder cta() => find.byKey(const ValueKey('character-generate-portrait'));

    testWidgets('a redraw spends nothing until it is confirmed', (
      tester,
    ) async {
      final repository = await pumpProfile(tester, drawn());

      await tester.tap(cta());
      await tester.pumpAndSettle();

      expect(find.text('Redraw Mina Park?'), findsOneWidget);
      // The price is the reason to ask at all, so it has to be in the
      // question and not only on the button behind it.
      expect(find.textContaining('for 45 credits'), findsOneWidget);
      expect(repository.portraitRequests, isEmpty);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(repository.portraitRequests, isEmpty);
      expect(find.text('Redraw Mina Park?'), findsNothing);
    });

    testWidgets('the question says what a redraw does not take away', (
      tester,
    ) async {
      await pumpProfile(tester, drawn());

      await tester.tap(cta());
      await tester.pumpAndSettle();

      expect(find.textContaining('stays in Pictures'), findsOneWidget);
      expect(
        find.textContaining('Books you have already made keep their look'),
        findsOneWidget,
      );
    });

    testWidgets('confirming draws once', (tester) async {
      final repository = await pumpProfile(tester, drawn());

      await tester.tap(cta());
      await tester.pumpAndSettle();
      await tester.tap(find.text('Redraw'));
      await tester.pumpAndSettle();

      expect(repository.portraitRequests, hasLength(1));
    });

    testWidgets('the first illustration is not gated', (tester) async {
      // The draw the whole screen has been asking for. A dialog here would
      // stand between the reader and the step they are being pushed towards.
      final repository = await pumpProfile(
        tester,
        testCharacter(photoKind: CharacterPhotoKind.photograph),
      );

      await tester.tap(cta());
      await tester.pumpAndSettle();

      expect(repository.portraitRequests, hasLength(1));
    });

    testWidgets('retrying a refunded failure is not gated', (tester) async {
      final repository = await pumpProfile(
        tester,
        testCharacter(portraitStatus: CharacterPortraitStatus.failed),
      );

      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(repository.portraitRequests, hasLength(1));
    });
  });

  testWidgets('coming back to a drawing in progress re-reads it', (
    tester,
  ) async {
    // The poll is lifecycle-aware because a drawing takes about a minute and
    // readers switch away: it stops on pause so the four-minute budget is not
    // spent in the background, and re-reads on resume. Nothing else covers a
    // real background round-trip with the timer running.
    await pumpProfile(
      tester,
      testCharacter(portraitStatus: CharacterPortraitStatus.generating),
      settle: false,
    );

    expect(find.textContaining('Drawing the illustration'), findsOneWidget);

    // The full walk, not a jump: AppLifecycleListener asserts on an illegal
    // transition, which is itself worth pinning — the mixin has to survive a
    // real backgrounding, not a synthetic one.
    for (final state in const [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
      await tester.pump();
    }

    expect(tester.takeException(), isNull);
    expect(find.textContaining('Drawing the illustration'), findsOneWidget);
  });

  testWidgets('a drawing is charged once however often the button is tapped', (
    tester,
  ) async {
    // The API is idempotent on requestId, and the app never used to send one —
    // so a tap after a timeout bought a second 45-credit drawing.
    final repository = await pumpProfile(
      tester,
      testCharacter(photoKind: CharacterPhotoKind.photograph),
    );

    await tester.tap(find.byKey(const ValueKey('character-generate-portrait')));
    await tester.pumpAndSettle();

    expect(repository.portraitRequests, hasLength(1));
    expect(repository.portraitRequests.single, isNotNull);
  });
}
