import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_controller.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// The composer's attachment surface: attach, send, retry, remove, and the
// warnings strip. Split from creation_chat_test.dart along the composer seam
// to keep that file inside its size budget.

void main() {
  testWidgets('attaching a document shows a ready chip and sends it with the '
      'message', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    final controller = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
    ).read(creationChatControllerProvider.notifier);
    await controller.attachFile(
      filename: 'outline.txt',
      bytes: const [104, 101, 108, 108, 111],
      isPhoto: false,
    );
    await tester.pumpAndSettle();

    expect(find.text('outline.txt'), findsOneWidget);
    expect(find.text('Ready to send'), findsOneWidget);

    await tester.enterText(find.byType(TextField).last, 'Use this outline');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(creation.sentMessages, contains('Use this outline'));
    expect(creation.sentAttachmentIds.last, ['att-1']);
    // The chip left the composer and now renders on the sent message bubble.
    expect(find.text('Ready to send'), findsNothing);
    expect(find.text('outline.txt'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a photo can be sent without any text, like a real chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    // The transcript photo falls back to the server copy, which needs asset
    // headers; the scripted projects repository keeps that request offline.
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: PlanProjectsRepository(),
        startFresh: true,
      ),
    );
    await tester.pumpAndSettle();

    final controller = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
    ).read(creationChatControllerProvider.notifier);

    // Nothing attached and no text: send stays disabled.
    expect(
      tester
          .widget<IconButton>(
            find.widgetWithIcon(IconButton, Icons.send_rounded),
          )
          .onPressed,
      isNull,
    );

    await controller.attachFile(
      filename: 'cover-idea.jpg',
      bytes: const [1, 2, 3],
      isPhoto: true,
      mimeType: 'image/jpeg',
    );
    await tester.pumpAndSettle();

    expect(
      tester
          .widget<IconButton>(
            find.widgetWithIcon(IconButton, Icons.send_rounded),
          )
          .onPressed,
      isNotNull,
    );
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(creation.sentMessages.last, isEmpty);
    expect(creation.sentAttachmentIds.last, ['att-1']);

    // The server copy's URL is kept so the photo can render after an app
    // restart or on another device, where the local file path is gone.
    final state = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
    ).read(creationChatControllerProvider);
    expect(
      state.attachmentUrls['att-1'],
      '/api/mobile/creation-sessions/draft-1/attachments/att-1/file',
    );

    await tester.teardownScreen();
  });

  testWidgets('failed uploads offer retry and removal', (tester) async {
    final creation = ScriptedCreationRepository()
      ..uploadError = Exception('network down');
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    final controller = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
    ).read(creationChatControllerProvider.notifier);
    await controller.attachFile(
      filename: 'draft.pdf',
      bytes: const [1, 2, 3],
      isPhoto: false,
    );
    await tester.pumpAndSettle();

    expect(find.text('Something went wrong. Try again.'), findsOneWidget);
    // Sending is not possible with only a failed attachment.
    expect(
      tester
          .widget<IconButton>(
            find.widgetWithIcon(IconButton, Icons.send_rounded),
          )
          .onPressed,
      isNull,
    );

    // The scripted upload error was consumed, so the retry succeeds.
    await tester.tap(find.text('Something went wrong. Try again.'));
    await tester.pumpAndSettle();

    expect(find.text('Ready to send'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.close));
    await tester.pumpAndSettle();

    expect(find.text('draft.pdf'), findsNothing);
    expect(creation.deletedAttachmentIds, ['att-1']);

    await tester.teardownScreen();
  });

  testWidgets('failed sends keep the message with retry and dismiss', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository()
      ..sendError = Exception('offline');
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'Hello book');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(find.text('Hello book'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('Dismiss'), findsOneWidget);

    creation.sendError = null;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    expect(find.text(reply), findsOneWidget);
    expect(find.text('Retry'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('server warnings render above the transcript', (tester) async {
    final creation = ScriptedCreationRepository()
      ..replyWarnings = const ['Keep the tone gentle for young readers.'];
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'A bedtime story');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(
      find.text('Keep the tone gentle for young readers.'),
      findsOneWidget,
    );

    await tester.teardownScreen();
  });

  testWidgets('attach menu offers photos, documents, and pasted notes', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Attach a photo, document, or notes'));
    await tester.pumpAndSettle();

    expect(find.text('Photo library'), findsOneWidget);
    expect(find.text('Take a photo'), findsOneWidget);
    expect(find.text('Document'), findsOneWidget);
    expect(find.text('Paste text notes'), findsOneWidget);

    await tester.tap(find.text('Paste text notes'));
    await tester.pumpAndSettle();

    expect(find.text('Source notes'), findsWidgets);

    await tester.teardownScreen();
  });
}
