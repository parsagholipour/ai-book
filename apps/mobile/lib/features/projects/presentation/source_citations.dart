import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/chat_markdown.dart';

/// Opens the passage a citation token points at. Tokens are issued and
/// validated by the server's evidence ledger; the bubble that renders them is
/// `ChatMessageText`.
Future<void> openSourcePassage(
  BuildContext context,
  WidgetRef ref,
  ChatCitation citation,
) async {
  final future = ref
      .read(apiClientProvider)
      .getMap(
        '/api/mobile/sources/${citation.sourceId}/versions/${citation.version}/passages/${citation.passage}',
      );
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.75,
      child: FutureBuilder<Map<String, dynamic>>(
        future: future,
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return const Center(
              child: Text('This source passage could not be loaded.'),
            );
          }
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final passage = snapshot.data!['passage'] as Map<String, dynamic>;
          return SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  passage['name'] as String,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                Text(passage['locator'] as String),
                const SizedBox(height: 16),
                SelectableText(passage['content'] as String),
              ],
            ),
          );
        },
      ),
    ),
  );
}
