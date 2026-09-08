import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/creation_message_models.dart';
import 'package:tomeza/features/projects/presentation/source_citations.dart';
import 'package:tomeza/shared/api/api_client.dart';

class _PassageApi implements ApiClient {
  String? requestedPath;
  @override
  Future<Map<String, dynamic>> getMap(
    String path, {
    bool requiresAuth = true,
  }) async {
    expect(requiresAuth, isTrue);
    requestedPath = path;
    return {
      'passage': {
        'name': 'Archive report',
        'locator': 'Page 93',
        'content': 'The code was ORCHID-913.',
      },
    };
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  testWidgets('a citation opens the authenticated passage and locator', (
    tester,
  ) async {
    final api = _PassageApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(api)],
        child: const MaterialApp(
          home: Scaffold(
            body: SourceCitationText('ORCHID-913 [source:src_archive:2:93000]'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('[Source 1]'));
    await tester.pumpAndSettle();
    expect(
      api.requestedPath,
      '/api/mobile/sources/src_archive/versions/2/passages/93000',
    );
    expect(find.text('Archive report'), findsOneWidget);
    expect(find.text('Page 93'), findsOneWidget);
    expect(find.text('The code was ORCHID-913.'), findsOneWidget);
  });
  test(
    'pending and partial status survives reloading the attachment response',
    () {
      final pending = MobileCreationAttachment.fromJson({
        'id': 's1',
        'processing': {'status': 'summarizing', 'progress': 72},
        'extractionVersion': 2,
      });
      expect(pending.isProcessing, isTrue);
      expect(pending.processingLabel, 'Reading · 72%');
      final partial = MobileCreationAttachment.fromJson({
        'id': 's1',
        'processing': {
          'status': 'partial',
          'acceptedPartial': false,
          'unreadable': ['Page 8'],
        },
      });
      expect(partial.isProcessing, isFalse);
      expect(partial.processingLabel, contains('review required'));
      expect(partial.processing?['unreadable'], ['Page 8']);
    },
  );
}
