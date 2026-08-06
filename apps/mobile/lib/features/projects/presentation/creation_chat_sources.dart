part of 'creation_chat_screen.dart';

// The citation list under an assistant message that used search grounding.
// Imports and shared state live in the parent library file.

class _ResearchSources extends StatelessWidget {
  const _ResearchSources({required this.sources, required this.foreground});

  final List<MobileCreationResearchSource> sources;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.public,
              size: 15,
              color: foreground.withValues(alpha: 0.8),
            ),
            const SizedBox(width: 5),
            Text(
              'Sources',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: foreground,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        for (var index = 0; index < sources.length; index++)
          _ResearchSourceLink(
            index: index + 1,
            source: sources[index],
            foreground: foreground,
          ),
      ],
    );
  }
}

class _ResearchSourceLink extends StatelessWidget {
  const _ResearchSourceLink({
    required this.index,
    required this.source,
    required this.foreground,
  });

  final int index;
  final MobileCreationResearchSource source;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    final uri = source.uri;
    final host = source.displayHost;
    final label = '$index. ${source.title}${host == null ? '' : ' · $host'}';
    final text = Text(
      label,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: Theme.of(context).textTheme.labelMedium?.copyWith(
        color: foreground,
        decoration: uri == null ? null : TextDecoration.underline,
        decorationColor: foreground,
      ),
    );
    if (uri == null) {
      return Padding(padding: const EdgeInsets.only(top: 3), child: text);
    }
    return Semantics(
      link: true,
      label:
          'Source $index. ${source.title}${host == null ? '' : '. Opens $host'}',
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: () => _open(context, uri),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: text,
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context, Uri uri) async {
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && context.mounted) {
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(content: Text('Could not open that source.')),
      );
    }
  }
}
