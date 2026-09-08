import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../shared/api/api_client.dart';

/// Citation tokens are issued and validated by the server's evidence ledger.
class SourceCitationText extends ConsumerWidget {
  const SourceCitationText(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;
  static final pattern = RegExp(r'\[source:([a-zA-Z0-9_-]+):(\d+):(\d+)\]');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final matches = pattern.allMatches(text).toList();
    if (matches.isEmpty) return Text(text, style: style);
    final spans = <InlineSpan>[];
    var cursor = 0;
    for (final match in matches) {
      spans.add(TextSpan(text: text.substring(cursor, match.start)));
      spans.add(
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: InkWell(
            onTap: () => _open(context, ref, match),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                '[Source ${matches.indexOf(match) + 1}]',
                style:
                    style?.copyWith(decoration: TextDecoration.underline) ??
                    const TextStyle(decoration: TextDecoration.underline),
              ),
            ),
          ),
        ),
      );
      cursor = match.end;
    }
    spans.add(TextSpan(text: text.substring(cursor)));
    return Text.rich(TextSpan(children: spans), style: style);
  }

  Future<void> _open(
    BuildContext context,
    WidgetRef ref,
    RegExpMatch match,
  ) async {
    final future = ref
        .read(apiClientProvider)
        .getMap(
          '/api/mobile/sources/${match[1]}/versions/${match[2]}/passages/${match[3]}',
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
}
