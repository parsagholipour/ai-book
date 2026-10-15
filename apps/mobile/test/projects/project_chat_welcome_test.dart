import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

import 'project_chat_harness_optimistic.dart';

/// A finished book whose chat has no messages yet.
class _FreshBookRepository extends ScriptedProjectsRepository {
  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async => const MobileProjectChat(messages: [], operations: []);

  @override
  Future<MobileProjectDetail> getProject(String id) async =>
      MobileProjectDetail(
        id: 'project-1',
        title: 'The Lantern Keeper',
        bookType: 'story',
        lengthPreset: 'standard',
        qualityPreset: 'balanced',
        imagesEnabled: true,
        status: 'complete',
        statusLabel: 'Complete',
        progressPercent: 100,
        currentAction: 'Done.',
        promptPreview: 'A story.',
        targetPages: 28,
        pageCount: 28,
        imageCount: 0,
        hasPlan: true,
        exports: const MobileExportSet(
          pdf: MobileExportAvailability(
            format: 'pdf',
            available: true,
            downloadUrl: '',
            filename: 'book.pdf',
            contentType: 'application/pdf',
          ),
          epub: MobileExportAvailability(
            format: 'epub',
            available: true,
            downloadUrl: '',
            filename: 'book.epub',
            contentType: 'application/epub+zip',
          ),
        ),
        createdAt: DateTime.utc(2026, 6, 15),
        updatedAt: DateTime.utc(2026, 6, 15),
        prompt: 'A story.',
        language: 'en',
        pages: const [],
      );
}

void main() {
  testWidgets('a fresh finished-book chat offers things to ask, and only fills '
      'the composer', (tester) async {
    final repository = _FreshBookRepository();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    expect(find.text('Talk to your book'), findsOneWidget);
    expect(find.text('The Lantern Keeper'), findsOneWidget);
    for (final title in [
      'Rewrite a page',
      'Add a picture',
      'Add a chapter',
      'Change the ending',
      'Ask for advice',
    ]) {
      expect(find.text(title), findsOneWidget, reason: title);
    }

    await tester.tap(find.text('Rewrite a page'));
    await tester.pump();

    final composer = tester.widget<TextField>(find.byType(TextField));
    expect(composer.controller?.text, 'Rewrite page  so it sounds warmer');
    // The cursor waits in the gap for the page number.
    expect(
      composer.controller?.selection,
      const TextSelection.collapsed(offset: 'Rewrite page '.length),
    );
    expect(repository.sentMessages, isEmpty);
  });

  testWidgets('the welcome goes away once the conversation has begun', (
    tester,
  ) async {
    // The scripted transcript already has messages in it.
    await tester.pumpWidget(chatApp(ScriptedProjectsRepository()));
    await tester.pumpAndSettle();

    expect(find.text('Talk to your book'), findsNothing);
    expect(find.text('Rewrite a page'), findsNothing);
  });
}
