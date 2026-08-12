import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/projects/data/creation_prefs_store.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_message_models.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/features/projects/presentation/mention_chips_row.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// What the composer sends when a message names one of the reader's saved
// characters. The stakes are not cosmetic: a mention that fails to register
// reaches the planner as nothing at all, and a planner with no character to
// copy invents one wearing the same name — which is what the finished book
// then illustrates.

/// A library the screen can resolve `@Name` against.
class FakeCharactersRepository implements CharactersRepository {
  FakeCharactersRepository(this.characters);

  final List<LibraryCharacter> characters;
  int listCalls = 0;

  @override
  Future<CharacterLibrary> list() async {
    listCalls += 1;
    return CharacterLibrary(characters: characters, portraitCredits: 40);
  }

  @override
  Future<Map<String, String>> assetHeaders() async => const {};

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

LibraryCharacter libraryCharacter({required String id, required String name}) {
  return LibraryCharacter(
    id: id,
    name: name,
    description: 'A great wife and future mother.',
    createdAt: DateTime.utc(2026, 6, 1),
    updatedAt: DateTime.utc(2026, 6, 1),
  );
}

/// Records the mentions each send actually put on the wire.
///
/// The two entry points are kept apart because the scripted fake answers a
/// first message by delegating `startConversation` to `sendConversationMessage`
/// without the mentions — a single list would end with that delegated call and
/// report an empty send for a message that carried one.
class MentionRecordingRepository extends ScriptedCreationRepository {
  MentionRecordingRepository({super.sessions});

  /// Mentions on the message that opened a brand-new chat.
  final startedMentions = <List<String>>[];

  /// Mentions on every later message, edits included.
  final sentMentions = <List<String>>[];

  @override
  Future<MobileCreationConversationResponse> startConversation({
    String? message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? requestId,
    List<String>? mentionedCharacterIds,
  }) {
    startedMentions.add(mentionedCharacterIds ?? const <String>[]);
    return super.startConversation(
      message: message,
      presets: presets,
      sourceNotes: sourceNotes,
      optionalDetails: optionalDetails,
      requestId: requestId,
      mentionedCharacterIds: mentionedCharacterIds,
    );
  }

  @override
  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    List<String>? attachmentIds,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? editMessageId,
    String? replyToMessageId,
    String? requestId,
    int? expectedRevision,
    bool skippedQuestion = false,
    List<String>? mentionedCharacterIds,
  }) {
    sentMentions.add(mentionedCharacterIds ?? const <String>[]);
    return super.sendConversationMessage(
      draftId: draftId,
      message: message,
      attachmentIds: attachmentIds,
      presets: presets,
      sourceNotes: sourceNotes,
      optionalDetails: optionalDetails,
      editMessageId: editMessageId,
      replyToMessageId: replyToMessageId,
      requestId: requestId,
      expectedRevision: expectedRevision,
      skippedQuestion: skippedQuestion,
      mentionedCharacterIds: mentionedCharacterIds,
    );
  }
}

Widget mentionApp({
  required CreationRepository creation,
  required CharactersRepository characters,
  String? draftId,
}) {
  return ProviderScope(
    overrides: [
      creationRepositoryProvider.overrideWithValue(creation),
      charactersRepositoryProvider.overrideWithValue(characters),
      billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      creationPrefsStoreProvider.overrideWithValue(MemoryCreationPrefsStore()),
    ],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: CreationChatScreen(draftId: draftId),
    ),
  );
}

Future<void> typeAndSend(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField).first, text);
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('Send'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a typed @Name is sent as a mention, whatever its case', (
    tester,
  ) async {
    final creation = MentionRecordingRepository();
    final characters = FakeCharactersRepository([
      libraryCharacter(id: 'lib-luna', name: 'Luna'),
    ]);
    await tester.pumpWidget(
      mentionApp(creation: creation, characters: characters),
    );
    await tester.pumpAndSettle();

    // Typed by hand and lowercased — never touched the suggestion strip, which
    // is the only thing that used to register a mention.
    await typeAndSend(tester, 'Write a book about @luna at school');

    expect(creation.startedMentions.single, ['lib-luna']);

    await tester.teardownScreen();
  });

  testWidgets('a name that is only part of a longer word is not a mention', (
    tester,
  ) async {
    final creation = MentionRecordingRepository();
    final characters = FakeCharactersRepository([
      libraryCharacter(id: 'lib-luna', name: 'Luna'),
    ]);
    await tester.pumpWidget(
      mentionApp(creation: creation, characters: characters),
    );
    await tester.pumpAndSettle();

    // `@Lunas` is a different word, and `write@luna.example` is an address —
    // binding either would attach a character the reader never named.
    await typeAndSend(tester, 'Ask @Lunas friend, or write@luna.example');

    expect(creation.startedMentions.single, isEmpty);

    await tester.teardownScreen();
  });

  testWidgets('a longer name wins over the shorter one inside it', (
    tester,
  ) async {
    final creation = MentionRecordingRepository();
    final characters = FakeCharactersRepository([
      libraryCharacter(id: 'lib-luna', name: 'Luna'),
      libraryCharacter(id: 'lib-luna-vega', name: 'Luna Vega'),
    ]);
    await tester.pumpWidget(
      mentionApp(creation: creation, characters: characters),
    );
    await tester.pumpAndSettle();

    await typeAndSend(tester, 'A story about @Luna Vega and the sea');

    expect(creation.startedMentions.single, ['lib-luna-vega']);

    await tester.teardownScreen();
  });

  testWidgets('two saved characters sharing a name bind neither', (
    tester,
  ) async {
    final creation = MentionRecordingRepository();
    final characters = FakeCharactersRepository([
      libraryCharacter(id: 'lib-luna-1', name: 'Luna'),
      libraryCharacter(id: 'lib-luna-2', name: 'Luna'),
    ]);
    await tester.pumpWidget(
      mentionApp(creation: creation, characters: characters),
    );
    await tester.pumpAndSettle();

    // Guessing which one would put the wrong face in the book, and the reader
    // has a way to say which they mean: pick from the strip.
    await typeAndSend(tester, 'A story about @Luna');

    expect(creation.startedMentions.single, isEmpty);

    await tester.teardownScreen();
  });

  testWidgets('the chips name every character attached to the message', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          charactersRepositoryProvider.overrideWithValue(
            FakeCharactersRepository([
              libraryCharacter(id: 'lib-luna', name: 'Luna'),
            ]),
          ),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: const Scaffold(
            body: MentionChipsRow(
              mentions: [
                MobileCreationCharacterRef(id: 'lib-luna', name: 'Luna'),
                // Not in the library the row can see — a chip still has to
                // name them, because the message is still carrying them.
                MobileCreationCharacterRef(id: 'lib-vega', name: 'Vega'),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Luna'), findsOneWidget);
    expect(find.text('Vega'), findsOneWidget);
  });

  testWidgets('the chips take no room when nothing is attached', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          charactersRepositoryProvider.overrideWithValue(
            FakeCharactersRepository(const []),
          ),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: const Scaffold(body: MentionChipsRow(mentions: [])),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.getSize(find.byType(MentionChipsRow)).height, 0);
  });

  testWidgets('editing a message keeps the mentions it was sent with', (
    tester,
  ) async {
    final creation = MentionRecordingRepository(
      sessions: [
        chatSession(draftId: 'draft-1', title: 'A book about Luna'),
      ],
    );
    creation.resumeMessages['draft-1'] = [
      {'id': 'c0', 'role': 'assistant', 'content': greeting},
      {
        'id': 'c1',
        'role': 'user',
        'content': 'Write about @Luna at school',
        'characters': [
          {'id': 'lib-luna', 'name': 'Luna'},
        ],
      },
    ];
    // Deliberately no library: the refs on the stored message are what has to
    // carry the mention through an edit, and a reader editing on a cold start
    // has not loaded their characters.
    final characters = FakeCharactersRepository(const []);

    await tester.pumpWidget(
      mentionApp(
        creation: creation,
        characters: characters,
        draftId: 'draft-1',
      ),
    );
    await tester.pumpAndSettle();

    await tester.longPress(bubbleText('Write about @Luna at school'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    await typeAndSend(tester, 'Write about @Luna at the beach');

    expect(creation.editRequests, ['c1']);
    expect(creation.sentMentions.last, ['lib-luna']);

    await tester.teardownScreen();
  });

  testWidgets('an edit that deletes the @Name drops the mention', (
    tester,
  ) async {
    final creation = MentionRecordingRepository(
      sessions: [
        chatSession(draftId: 'draft-1', title: 'A book about Luna'),
      ],
    );
    creation.resumeMessages['draft-1'] = [
      {'id': 'c0', 'role': 'assistant', 'content': greeting},
      {
        'id': 'c1',
        'role': 'user',
        'content': 'Write about @Luna at school',
        'characters': [
          {'id': 'lib-luna', 'name': 'Luna'},
        ],
      },
    ];

    await tester.pumpWidget(
      mentionApp(
        creation: creation,
        characters: FakeCharactersRepository(const []),
        draftId: 'draft-1',
      ),
    );
    await tester.pumpAndSettle();

    await tester.longPress(bubbleText('Write about @Luna at school'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    // Taking the name out of the sentence is how a mention is removed; the
    // composer listener prunes it with no extra bookkeeping.
    await typeAndSend(tester, 'Write about a school instead');

    expect(creation.sentMentions.last, isEmpty);

    await tester.teardownScreen();
  });
}
