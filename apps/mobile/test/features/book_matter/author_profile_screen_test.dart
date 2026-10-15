import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/book_matter/data/book_matter_repository.dart';
import 'package:tomeza/features/book_matter/domain/author_profile.dart';
import 'package:tomeza/features/book_matter/presentation/author_profile_screen.dart';

import 'fake_book_matter_repository.dart';

// Account → Author profile: what every new book takes a copy of. Saving sends
// only what changed, and answers the book page's one-time prompt.

Future<void> _pump(WidgetTester tester, FakeBookMatterRepository repo) async {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const Scaffold(body: Text('library')),
      ),
      // Account is opened from the library, as in the app: a pop that misses
      // the profile has a page to take away.
      GoRoute(
        path: '/account',
        builder: (_, _) => const Scaffold(body: Text('account hub')),
      ),
      GoRoute(
        path: authorProfileLocation,
        builder: (_, _) => const AuthorProfileScreen(),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.binding.setSurfaceSize(const Size(420, 1800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [bookMatterRepositoryProvider.overrideWithValue(repo)],
      child: MaterialApp.router(
        theme: buildTomezaLightTheme(),
        routerConfig: router,
      ),
    ),
  );
  router.push('/account');
  await tester.pumpAndSettle();
  router.push(authorProfileLocation);
  await tester.pumpAndSettle();
}

/// The account hub is the page on top, with the profile gone.
void _expectAccountHub() {
  expect(find.byType(AuthorProfileForm), findsNothing);
  expect(find.text('account hub'), findsOneWidget);
  expect(find.text('library'), findsNothing);
}

/// Taps Save and leaves the save in flight until the gate opens.
Future<Completer<void>> _saveAndHold(
  WidgetTester tester,
  FakeBookMatterRepository repo,
) async {
  final gate = repo.writeGate = Completer<void>();
  final save = find.byKey(const ValueKey('profile-save'));
  await tester.ensureVisible(save);
  await tester.tap(save);
  await tester.pump();
  expect(repo.writes.single.method, 'PUT profile');
  return gate;
}

/// The app bar's back arrow.
Future<void> _tapBack(WidgetTester tester) =>
    tester.tap(find.byType(BackButton));

TextField _field(WidgetTester tester, String key) =>
    tester.widget<TextField>(find.byKey(ValueKey(key)));

Future<void> _type(WidgetTester tester, String key, String text) async {
  final field = find.byKey(ValueKey(key));
  await tester.ensureVisible(field);
  await tester.enterText(field, text);
  await tester.pump();
}

Future<void> _tap(WidgetTester tester, String key) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  group('authorProfileChanges', () {
    const seen = AuthorProfile(
      penName: 'Mira Q.',
      bio: 'Writes at night.',
      setupPromptSeen: true,
    );

    test('nothing changed on an answered profile is nothing to send', () {
      expect(
        authorProfileChanges(
          seen,
          penName: ' Mira Q. ',
          bio: 'Writes at night.',
          website: '',
          copyrightHolder: '  ',
          imprint: '',
          allRightsReserved: false,
          includeAboutAuthor: true,
        ),
        isNull,
      );
    });

    test('an unanswered profile always answers the prompt', () {
      final update = authorProfileChanges(
        const AuthorProfile(),
        penName: '',
        bio: '',
        website: '',
        copyrightHolder: '',
        imprint: '',
        allRightsReserved: false,
        includeAboutAuthor: true,
      );
      expect(update?.toJson(), {'setupPromptSeen': true});
    });

    test('changed text is sent trimmed, emptied text is cleared, switches '
        'only when moved', () {
      final update = authorProfileChanges(
        seen,
        penName: ' M. Quinn ',
        bio: '',
        website: 'mira.dev',
        copyrightHolder: '',
        imprint: '',
        allRightsReserved: true,
        includeAboutAuthor: true,
      );
      expect(update?.toJson(), {
        'penName': 'M. Quinn',
        'website': 'mira.dev',
        'allRightsReserved': true,
        'bio': null,
      });
    });
  });

  testWidgets('the account name is offered, never filled in or saved by '
      'itself', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(suggestedPenName: 'Mira'),
    );
    await _pump(tester, repo);

    expect(find.text('Author profile'), findsOneWidget);
    expect(_field(tester, 'profile-pen-name').controller!.text, isEmpty);
    expect(_field(tester, 'profile-pen-name').decoration!.hintText, 'Mira');
    expect(find.text('Use “Mira”'), findsOneWidget);
    expect(repo.writes, isEmpty);

    await _tap(tester, 'pen-name-suggestion');
    expect(_field(tester, 'profile-pen-name').controller!.text, 'Mira');
    expect(find.text('Use “Mira”'), findsNothing);
    // Picking it is still only a draft until Save.
    expect(repo.writes, isEmpty);
  });

  testWidgets('Save sends only what changed, marks the prompt seen, and goes '
      'back', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(
        website: 'old.example',
        suggestedPenName: 'Mira',
      ),
    );
    await _pump(tester, repo);

    await _type(tester, 'profile-pen-name', ' Mira Q. ');
    await _type(tester, 'profile-bio', 'Writes small books for small people.');
    await _type(tester, 'profile-website', '');
    await _tap(tester, 'profile-rights');
    await _tap(tester, 'profile-save');

    expect(repo.writes.single.method, 'PUT profile');
    expect(repo.writes.single.body, {
      'penName': 'Mira Q.',
      'bio': 'Writes small books for small people.',
      'allRightsReserved': true,
      'setupPromptSeen': true,
      'website': null,
    });
    expect(find.text('account hub'), findsOneWidget);
    expect(find.text('Saved. Your next books will use it.'), findsOneWidget);
  });

  testWidgets('an answered profile sends no prompt flag, and a switch turned '
      'off is sent off', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(
        penName: 'Mira Q.',
        bio: 'Writes at night.',
        setupPromptSeen: true,
      ),
    );
    await _pump(tester, repo);

    expect(_field(tester, 'profile-bio').controller!.text, 'Writes at night.');
    await _tap(tester, 'profile-include-about');
    await _tap(tester, 'profile-save');

    expect(repo.writes.single.body, {'includeAboutAuthor': false});
  });

  testWidgets('publishing details open, and the holder defaults to the pen '
      'name', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(penName: 'Mira Q.', setupPromptSeen: true),
    );
    await _pump(tester, repo);

    expect(find.byKey(const ValueKey('profile-holder')), findsNothing);
    expect(find.text('Copyright holder and imprint'), findsOneWidget);
    await _tap(tester, 'profile-publishing-toggle');

    expect(_field(tester, 'profile-holder').decoration!.hintText, 'Mira Q.');
    await _type(tester, 'profile-imprint', 'Moonlit Press');
    await _tap(tester, 'profile-save');
    expect(repo.writes.single.body, {'imprint': 'Moonlit Press'});
  });

  testWidgets('words the server refuses are marked where they are, and '
      'nothing is lost', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(penName: 'Mira Q.', setupPromptSeen: true),
    )..profileWriteError = FakeBookMatterRepository.refusal(['imprint']);
    await _pump(tester, repo);

    await _tap(tester, 'profile-publishing-toggle');
    await _type(tester, 'profile-imprint', 'Something unprintable');
    // Close the section again; the refusal has to open it to be seen.
    await _tap(tester, 'profile-publishing-toggle');
    await _tap(tester, 'profile-save');

    expect(find.text('Could not save'), findsOneWidget);
    expect(find.text('That can’t be printed in a book.'), findsOneWidget);
    expect(find.text('Change this to save.'), findsOneWidget);
    expect(
      _field(tester, 'profile-imprint').controller!.text,
      'Something unprintable',
    );
    expect(find.text('account hub'), findsNothing);
  });

  testWidgets('a profile that cannot be read says so and tries again', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(penName: 'Mira Q.'),
    )..profileReadError = FakeBookMatterRepository.busy;
    await _pump(tester, repo);

    expect(find.text('Author profile unavailable'), findsOneWidget);
    repo.profileReadError = null;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(_field(tester, 'profile-pen-name').controller!.text, 'Mira Q.');
  });

  testWidgets('a save that lands while the screen is still sliding away '
      'leaves the account page where it is', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(setupPromptSeen: true),
    );
    await _pump(tester, repo);

    await _type(tester, 'profile-pen-name', 'Mira Q.');
    final gate = await _saveAndHold(tester, repo);
    await _tapBack(tester);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    // Mid-slide: the form is still built, but its route is not on top.
    expect(find.byType(AuthorProfileForm), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();
    _expectAccountHub();
    expect(repo.profile.penName, 'Mira Q.');
    expect(find.text('Saved. Your next books will use it.'), findsOneWidget);
  });

  testWidgets('a save that lands after the screen has gone still says it '
      'saved', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(setupPromptSeen: true),
    );
    await _pump(tester, repo);

    await _type(tester, 'profile-pen-name', 'Mira Q.');
    final gate = await _saveAndHold(tester, repo);
    await _tapBack(tester);
    await tester.pumpAndSettle();
    _expectAccountHub();

    gate.complete();
    await tester.pumpAndSettle();
    expect(repo.profile.penName, 'Mira Q.');
    expect(find.text('Saved. Your next books will use it.'), findsOneWidget);
    expect(find.byKey(const ValueKey('author-profile-not-saved')), findsNothing);
  });

  testWidgets('a save refused after the screen was left says it was not '
      'saved', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(setupPromptSeen: true),
    )..profileWriteError = FakeBookMatterRepository.refusal(['penName']);
    await _pump(tester, repo);

    await _type(tester, 'profile-pen-name', 'Something unprintable');
    final gate = await _saveAndHold(tester, repo);
    await _tapBack(tester);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byType(AuthorProfileForm), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();
    _expectAccountHub();
    expect(
      find.text(
        'Your author profile wasn’t saved. Some of it can’t be printed in a '
        'book.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('leaving with typed words asks first, every way out, and Keep '
      'editing keeps them', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(penName: 'Mira Q.', setupPromptSeen: true),
    );
    await _pump(tester, repo);
    await _type(tester, 'profile-bio', 'Writes at night.');

    final waysOut = <String, Future<void> Function()>{
      'the back arrow': () => _tapBack(tester),
      'Back': () => tester.binding.handlePopRoute(),
    };
    for (final MapEntry(key: way, value: leave) in waysOut.entries) {
      await leave();
      await tester.pumpAndSettle();
      expect(find.text('Discard changes?'), findsOneWidget, reason: way);
      await tester.tap(find.text('Keep editing'));
      await tester.pumpAndSettle();
      expect(find.text('Discard changes?'), findsNothing, reason: way);
      expect(find.byType(AuthorProfileForm), findsOneWidget, reason: way);
      expect(
        _field(tester, 'profile-bio').controller!.text,
        'Writes at night.',
        reason: way,
      );
    }

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard changes'));
    await tester.pumpAndSettle();
    _expectAccountHub();
    expect(repo.writes, isEmpty);
  });

  testWidgets('with nothing changed, leaving does not ask — a profile that '
      'never answered the prompt included', (tester) async {
    final repo = FakeBookMatterRepository(
      profile: const AuthorProfile(suggestedPenName: 'Mira'),
    );
    await _pump(tester, repo);

    // Typed and put back is nothing changed.
    await _type(tester, 'profile-pen-name', 'Mira');
    await _type(tester, 'profile-pen-name', '');
    await _tapBack(tester);
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsNothing);
    _expectAccountHub();
    expect(repo.writes, isEmpty);

    // A switch flipped is a change.
    final router = GoRouter.of(tester.element(find.text('account hub')));
    router.push(authorProfileLocation);
    await tester.pumpAndSettle();
    await _tap(tester, 'profile-rights');
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsOneWidget);
  });
}
