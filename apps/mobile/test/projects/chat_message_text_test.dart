import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/chat_message_text.dart';
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

Future<void> _pump(WidgetTester tester, Widget child, {ApiClient? api}) {
  return tester.pumpWidget(
    ProviderScope(
      overrides: [if (api != null) apiClientProvider.overrideWithValue(api)],
      child: MaterialApp(home: Scaffold(body: child)),
    ),
  );
}

void main() {
  testWidgets('a numbered list renders markers beside each item', (
    tester,
  ) async {
    await _pump(
      tester,
      const ChatMessageText(
        "Here's what I found:\n1. **Chaco War**, 1932–1935\n2. War of the Pacific\nDone.",
      ),
    );
    expect(find.text("Here's what I found:"), findsOneWidget);
    expect(find.text('1.'), findsOneWidget);
    expect(find.text('2.'), findsOneWidget);
    expect(find.text('Chaco War, 1932–1935'), findsOneWidget);
    expect(find.text('War of the Pacific'), findsOneWidget);
    expect(find.text('Done.'), findsOneWidget);
    // The item text hangs beside its marker rather than under it.
    final marker = tester.getTopLeft(find.text('1.'));
    final item = tester.getTopLeft(find.text('Chaco War, 1932–1935'));
    expect(item.dx, greaterThan(marker.dx));
    expect((item.dy - marker.dy).abs(), lessThan(2));
  });

  testWidgets('bold is bold and the rest of the line is not', (tester) async {
    await _pump(tester, const ChatMessageText('The **Chaco War** ended.'));
    final rich = tester.widget<Text>(find.text('The Chaco War ended.'));
    final spans = (rich.textSpan as TextSpan).children!.cast<TextSpan>();
    expect(spans.map((s) => s.text), ['The ', 'Chaco War', ' ended.']);
    expect(spans[1].style?.fontWeight, FontWeight.w700);
    expect(spans[0].style?.fontWeight, isNot(FontWeight.w700));
  });

  testWidgets("a user's own message is shown verbatim", (tester) async {
    await _pump(
      tester,
      const ChatMessageText('1. **not** a list', markdown: false),
    );
    expect(find.text('1. **not** a list'), findsOneWidget);
  });

  testWidgets('a Persian reply lays out right-to-left', (tester) async {
    await _pump(tester, const ChatMessageText('۱. سلام\n۲. خداحافظ'));
    final directionality = tester.widget<Directionality>(
      find
          .descendant(
            of: find.byType(ChatMessageText),
            matching: find.byType(Directionality),
          )
          .first,
    );
    expect(directionality.textDirection, TextDirection.rtl);
    expect(find.text('۱.'), findsOneWidget);
    expect(find.text('۲.'), findsOneWidget);
    // Row follows ambient RTL: the marker is the first child, so it sits
    // to the right of the item text.
    expect(
      tester.getTopLeft(find.text('۱.')).dx,
      greaterThan(tester.getTopLeft(find.text('سلام')).dx),
    );
  });

  testWidgets('a citation opens the authenticated passage and locator', (
    tester,
  ) async {
    final api = _PassageApi();
    await _pump(
      tester,
      const ChatMessageText('ORCHID-913 [source:src_archive:2:93000]'),
      api: api,
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
}
