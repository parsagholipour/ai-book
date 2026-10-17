import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../characters/data/characters_repository.dart';
import '../../characters/domain/character_models.dart';
import '../../characters/presentation/character_editor_sheet.dart';
import '../../characters/presentation/character_profile_screen.dart';
import '../../voice/data/voice_repository.dart';
import '../../voice/domain/voice_models.dart';
import '../../voice/presentation/voice_call_avatar.dart';
import '../../voice/presentation/voice_call_launcher.dart';
import '../data/making_of_repository.dart';
import '../domain/making_of_models.dart';
import 'generation_duration.dart';

/// How many sources show before "Show all".
const _sourcesShownFolded = 4;

/// "Planned in 1m 12s, written in 1m 39s." — or null when there is no planning
/// time to add: the card's facts already say how long the writing took, and a
/// line that only repeats it is not worth a row.
String? makingOfTimingLine({int? planningMs, int? bookMs}) {
  final planned = formatGenerationDuration(planningMs);
  if (planned == null) return null;
  final written = formatGenerationDuration(bookMs);
  return written == null
      ? 'Planned in $planned.'
      : 'Planned in $planned, written in $written.';
}

/// The folded row's promise, one part per kind of thing behind it:
/// "2 characters", "5 chapters", "15 sources".
List<String> makingOfTeaserParts(MobileMakingOf makingOf) {
  final cast = makingOf.cast.length;
  final chapters = makingOf.readableChapters.length;
  final sources = makingOf.sourceCount;
  return [
    if (cast > 0) cast == 1 ? '1 character' : '$cast characters',
    if (chapters > 0) '$chapters chapters',
    if (sources > 0) sources == 1 ? '1 source' : '$sources sources',
  ];
}

/// The same promise as one sentence, for a screen reader.
String? makingOfTeaser(MobileMakingOf makingOf) {
  final parts = makingOfTeaserParts(makingOf);
  return parts.isEmpty ? null : parts.join(' · ');
}

/// "Behind the book": the folded section at the foot of a finished book's
/// card, and the part of it a reader comes back to.
///
/// It replaced a list of the job's steps — "5 chapters", "10 pages", "Cover
/// ready", "PDF and EPUB ready" — which said again what the line above it and
/// the buttons beside it already said. What it shows now is what nothing else
/// on the screen does: the book's cast, with a way to call each of them or keep
/// them for the next book; its chapters, each one a door into the reader; and
/// the sources the writer read, which otherwise reach a reader only as printed
/// back matter, and only in the categories that print it. Nothing here says a
/// source was checked, because nothing checks one.
///
/// Every part hides itself when the book has none of it, and the whole row is
/// gone when there is nothing at all, rather than a door into an empty room.
/// The folded row names what is inside ("2 characters · 5 chapters"), because
/// a folded row is all most readers ever see of it.
class BehindTheBookSection extends ConsumerStatefulWidget {
  const BehindTheBookSection({
    required this.projectId,
    this.planningMs,
    this.bookMs,
    super.key,
  });

  final String projectId;
  final int? planningMs;
  final int? bookMs;

  @override
  ConsumerState<BehindTheBookSection> createState() =>
      _BehindTheBookSectionState();
}

class _BehindTheBookSectionState extends ConsumerState<BehindTheBookSection> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final reduced = AppMotion.reducedMotion(context);
    final value = ref.watch(makingOfProvider(widget.projectId));
    final makingOf = value.asData?.value ?? MobileMakingOf.empty;
    final loading = value.asData == null && !value.hasError;
    final timing = makingOfTimingLine(
      planningMs: widget.planningMs,
      bookMs: widget.bookMs,
    );
    if (!loading && makingOf.isEmpty && timing == null) {
      return const SizedBox.shrink();
    }
    final teaser = makingOfTeaserParts(makingOf);
    void toggle() => setState(() => _open = !_open);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Divider(height: 1, color: colors.outlineVariant),
        _Header(
          open: _open,
          teaser: teaser,
          faces: makingOf.cast.take(3).toList(growable: false),
          onTap: toggle,
        ),
        AnimatedSize(
          duration: reduced ? Duration.zero : AppMotion.medium,
          curve: AppMotion.enter,
          alignment: Alignment.topCenter,
          child: _open
              ? Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md,
                    0,
                    AppSpacing.md,
                    AppSpacing.md,
                  ),
                  child: loading
                      ? const _LoadingRows()
                      : _Body(
                          projectId: widget.projectId,
                          makingOf: makingOf,
                          timing: timing,
                        ),
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.open,
    required this.teaser,
    required this.faces,
    required this.onTap,
  });

  final bool open;
  final List<String> teaser;
  final List<VoiceCharacter> faces;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final reduced = AppMotion.reducedMotion(context);
    return Semantics(
      container: true,
      button: true,
      expanded: open,
      label: teaser.isEmpty
          ? 'Behind the book'
          : 'Behind the book. ${teaser.join(' · ')}',
      onTap: onTap,
      child: ExcludeSemantics(
        child: InkWell(
          key: const ValueKey('finished-card-behind'),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.md,
                vertical: AppSpacing.xs,
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.auto_stories_outlined,
                    size: 18,
                    color: colors.onSurfaceVariant,
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          'Behind the book',
                          style: text.labelLarge?.copyWith(
                            color: colors.onSurface,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        if (teaser.isNotEmpty)
                          _TeaserParts(
                            parts: teaser,
                            style: text.bodySmall?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                      ],
                    ),
                  ),
                  if (faces.isNotEmpty) ...[
                    const SizedBox(width: AppSpacing.xs),
                    _FaceStack(faces: faces),
                  ],
                  const SizedBox(width: AppSpacing.xxs),
                  AnimatedRotation(
                    turns: open ? 0.5 : 0,
                    duration: reduced ? Duration.zero : AppMotion.medium,
                    child: Icon(
                      Icons.expand_more,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The teaser's parts on one line while they fit, breaking only between two
/// of them, so "15" is never left at the end of a line without its "sources".
class _TeaserParts extends StatelessWidget {
  const _TeaserParts({required this.parts, required this.style});

  final List<String> parts;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      children: [
        for (var i = 0; i < parts.length; i++)
          Text(
            i < parts.length - 1 ? '${parts[i]}  ·  ' : parts[i],
            style: style,
            softWrap: false,
          ),
      ],
    );
  }
}

/// Up to three faces, overlapping, each ringed in the card's own colour so
/// the overlap reads as a stack rather than a smudge. The first is drawn on
/// top and each one after it peeks out from behind by less than half a face,
/// so a cast with no pictures yet still shows every set of initials whole.
class _FaceStack extends StatelessWidget {
  const _FaceStack({required this.faces});

  final List<VoiceCharacter> faces;

  static const double _diameter = 28;
  static const double _ring = 2;
  static const double _step = 24;

  @override
  Widget build(BuildContext context) {
    final ring = Theme.of(context).colorScheme.surfaceContainerLowest;
    const outer = _diameter + _ring * 2;
    return SizedBox(
      width: outer + _step * (faces.length - 1),
      height: outer,
      child: Stack(
        children: [
          for (var i = faces.length - 1; i >= 0; i--)
            Positioned(
              left: _step * i,
              child: Container(
                padding: const EdgeInsets.all(_ring),
                decoration: BoxDecoration(color: ring, shape: BoxShape.circle),
                child: VoiceCallFace(character: faces[i], diameter: _diameter),
              ),
            ),
        ],
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({
    required this.projectId,
    required this.makingOf,
    required this.timing,
  });

  final String projectId;
  final MobileMakingOf makingOf;
  final String? timing;

  @override
  Widget build(BuildContext context) {
    final chapters = makingOf.readableChapters;
    final sections = <Widget>[
      if (makingOf.cast.isNotEmpty)
        _Part(
          label: makingOf.cast.length == 1 ? 'The character' : 'The cast',
          children: [
            for (final character in makingOf.cast)
              _CastRow(projectId: projectId, character: character),
          ],
        ),
      if (chapters.isNotEmpty)
        _Part(
          label: 'Chapter by chapter',
          children: [
            for (var i = 0; i < chapters.length; i++)
              _ChapterRow(
                location: readerLocationForChapter(
                  projectId,
                  chapters[i],
                  makingOf.pdfDigest,
                ),
                position: i + 1,
                chapter: chapters[i],
              ),
          ],
        ),
      if (makingOf.sources.isNotEmpty)
        _Part(
          label: 'Sources read while writing',
          children: [
            _SourceList(
              sources: makingOf.sources,
              sourceCount: makingOf.sourceCount,
            ),
          ],
        ),
      if (timing != null) _TimingLine(text: timing!),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < sections.length; i++) ...[
          if (i > 0) const SizedBox(height: AppSpacing.sm),
          sections[i],
        ],
      ],
    );
  }
}

class _Part extends StatelessWidget {
  const _Part({required this.label, required this.children});

  final String label;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.xxs),
            child: Text(
              label.toUpperCase(),
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: colors.onSurfaceVariant,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.8,
              ),
            ),
          ),
        ),
        ...children,
      ],
    );
  }
}

/// One of the book's cast: who they are, and the two things to do with them.
///
/// Call re-reads the cast at the tap, as the library's Call does, because the
/// price and the balance a call needs move between taps and the making-of read
/// carries neither. Save opens the character editor with this cast member's
/// name and description already in it, and saves nothing until the reader
/// does; their picture is not carried over, because a book's cast portrait is
/// this book's drawing and the library draws its own.
class _CastRow extends ConsumerStatefulWidget {
  const _CastRow({required this.projectId, required this.character});

  final String projectId;
  final VoiceCharacter character;

  @override
  ConsumerState<_CastRow> createState() => _CastRowState();
}

class _CastRowState extends ConsumerState<_CastRow> {
  bool _calling = false;

  /// Saved from this row during this visit, before the library read catches up.
  String? _savedId;

  /// The saved character this cast member already is: the book's own link
  /// when it was made from one, else one of the same name.
  String? _libraryId(CharacterLibrary? library) {
    final character = widget.character;
    if (character.libraryCharacterId != null) {
      return character.libraryCharacterId;
    }
    if (_savedId != null) return _savedId;
    final name = character.name.trim().toLowerCase();
    for (final saved in library?.characters ?? const <LibraryCharacter>[]) {
      if (saved.name.trim().toLowerCase() == name) return saved.id;
    }
    return null;
  }

  Future<void> _call() async {
    final messenger = ScaffoldMessenger.of(context);
    final character = widget.character;
    if (voiceCallsLockedByPlan(ref.read(billingProvider).asData?.value)) {
      await showVoiceCallPlanOffer(context, ref, projectId: widget.projectId);
      return;
    }
    setState(() => _calling = true);
    final VoiceCast cast;
    try {
      cast = await ref.refresh(voiceCastProvider(widget.projectId).future);
    } catch (error) {
      if (mounted) setState(() => _calling = false);
      messenger.showAppSnackBar(
        SnackBar(content: Text(userFacingError(error))),
      );
      return;
    }
    if (!mounted) return;
    setState(() => _calling = false);
    final live = cast.characters.firstWhere(
      (entry) => entry.id == character.id,
      orElse: () => character,
    );
    await launchVoiceCall(
      context: context,
      ref: ref,
      projectId: widget.projectId,
      character: live,
      cast: cast,
    );
  }

  Future<void> _save() async {
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    final character = widget.character;
    final created = await showCharacterEditorSheet(
      context,
      draft: CharacterDraft(
        name: character.name,
        description: character.description.isNotEmpty
            ? character.description
            : character.role,
      ),
    );
    if (created == null || !mounted) return;
    setState(() => _savedId = created.id);
    ref.invalidate(charactersProvider);
    messenger.showAppSnackBar(
      SnackBar(
        content: Text('${created.name} is in your characters now.'),
        action: SnackBarAction(
          label: 'View',
          onPressed: () => navigator.push(characterProfileRoute(created.id)),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final character = widget.character;
    final libraryId = _libraryId(ref.watch(charactersProvider).asData?.value);
    final role = character.role.trim();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
      child: Row(
        children: [
          VoiceCallFace(character: character, diameter: 40),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  character.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: text.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
                if (role.isNotEmpty)
                  Text(
                    role,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
          if (libraryId != null)
            IconButton(
              key: ValueKey('behind-open-${character.id}'),
              tooltip: '${character.name} is in your characters',
              color: colors.primary,
              icon: const Icon(Icons.bookmark_added),
              onPressed: () =>
                  Navigator.of(context).push(characterProfileRoute(libraryId)),
            )
          else
            IconButton(
              key: ValueKey('behind-save-${character.id}'),
              tooltip: 'Save ${character.name} to your characters',
              icon: const Icon(Icons.bookmark_add_outlined),
              onPressed: _save,
            ),
          if (character.callable)
            IconButton(
              key: ValueKey('behind-call-${character.id}'),
              tooltip: 'Call ${character.name}',
              onPressed: _calling ? null : _call,
              icon: _calling
                  ? const SizedBox.square(
                      dimension: AppSizes.buttonProgressIndicator,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.call_outlined),
            ),
        ],
      ),
    );
  }
}

class _ChapterRow extends StatelessWidget {
  const _ChapterRow({
    required this.location,
    required this.position,
    required this.chapter,
  });

  /// Where in the reader the chapter opens ([readerLocationForChapter]).
  final String location;
  final int position;
  final MakingOfChapter chapter;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final title = chapter.title.isEmpty ? 'Chapter $position' : chapter.title;
    void open() => context.push(location);
    return Semantics(
      button: true,
      label: 'Chapter $position, $title. Opens the book there.',
      onTap: open,
      child: ExcludeSemantics(
        child: InkWell(
          key: ValueKey('behind-chapter-$position'),
          borderRadius: BorderRadius.circular(AppRadii.control),
          onTap: open,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 24,
                  height: 24,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: colors.secondaryContainer,
                    shape: BoxShape.circle,
                  ),
                  child: Text(
                    '$position',
                    style: text.labelSmall?.copyWith(
                      color: colors.onSecondaryContainer,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: text.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (chapter.summary.isNotEmpty)
                        Text(
                          chapter.summary,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: text.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                ),
                Icon(
                  Icons.chevron_right,
                  size: 20,
                  color: colors.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SourceList extends StatefulWidget {
  const _SourceList({required this.sources, required this.sourceCount});

  final List<MakingOfSource> sources;
  final int sourceCount;

  @override
  State<_SourceList> createState() => _SourceListState();
}

class _SourceListState extends State<_SourceList> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final sources = widget.sources;
    final folds = sources.length > _sourcesShownFolded;
    final shown = _all || !folds
        ? sources
        : sources.take(_sourcesShownFolded).toList(growable: false);
    final unlisted = widget.sourceCount - sources.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final source in shown) _SourceRow(source: source),
        if (_all && unlisted > 0)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.xxs),
            child: Text(
              unlisted == 1 ? 'And 1 more.' : 'And $unlisted more.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        if (folds)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.text(
              onPressed: () => setState(() => _all = !_all),
              label: _all ? 'Show fewer' : 'Show all ${widget.sourceCount}',
            ),
          ),
      ],
    );
  }
}

class _SourceRow extends StatelessWidget {
  const _SourceRow({required this.source});

  final MakingOfSource source;

  Future<void> _open(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final opened = await launchUrl(
      source.uri,
      mode: LaunchMode.externalApplication,
    );
    if (!opened) {
      messenger.showAppSnackBar(
        const SnackBar(content: Text('Could not open that source.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final subtitle = source.subtitle;
    return Semantics(
      link: true,
      label: '${source.title}. Opens ${source.host ?? 'in your browser'}',
      child: ExcludeSemantics(
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadii.control),
          onTap: () => _open(context),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget,
            ),
            child: Row(
              children: [
                Icon(Icons.public, size: 18, color: colors.onSurfaceVariant),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        source.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: text.bodyMedium,
                      ),
                      if (subtitle != null)
                        Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: text.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                ),
                Icon(
                  Icons.open_in_new,
                  size: 16,
                  color: colors.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TimingLine extends StatelessWidget {
  const _TimingLine({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      children: [
        Icon(Icons.schedule, size: 16, color: colors.onSurfaceVariant),
        const SizedBox(width: AppSpacing.xs),
        Expanded(
          child: Text(
            text,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}

/// What the open section shows in the moment before the read answers: the
/// shape of the rows that are coming, never a bare spinner.
class _LoadingRows extends StatelessWidget {
  const _LoadingRows();

  @override
  Widget build(BuildContext context) {
    final fill = Theme.of(context).colorScheme.surfaceContainerHigh;
    Widget bar(double widthFactor) => FractionallySizedBox(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: widthFactor,
      child: Container(
        height: 12,
        margin: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(AppRadii.pill),
        ),
      ),
    );
    return Semantics(
      label: 'Loading the details',
      child: Column(children: [bar(0.55), bar(0.8), bar(0.7)]),
    );
  }
}
