import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../data/reader_storage.dart';

/// The one-time hints the reader can give.
enum ReaderCoachTip {
  /// Tap the page to put the controls away; press and hold a word to work
  /// with it. The two gestures nothing on screen advertises.
  readingBasics,
}

/// Remembers which hints a reader has already been shown.
///
/// A hint that comes back every time the book opens is a nag, so the answer has
/// to outlive the process. It sits at the root of the reader's storage next to
/// the reader's other preferences — it is about the person, not the book — and
/// is deliberately forgiving: any failure to read it counts as "seen". A hint
/// that is missed is a small loss; one that cannot be dismissed for good is not.
abstract interface class ReaderCoachStore {
  Future<bool> hasSeen(ReaderCoachTip tip);

  Future<void> markSeen(ReaderCoachTip tip);
}

class FileReaderCoachStore implements ReaderCoachStore {
  FileReaderCoachStore({required this.storage});

  final ReaderStorage storage;

  static const _filename = 'coach.json';

  @override
  Future<bool> hasSeen(ReaderCoachTip tip) async {
    try {
      return (await _read()).contains(tip.name);
    } catch (_) {
      return true;
    }
  }

  @override
  Future<void> markSeen(ReaderCoachTip tip) async {
    try {
      final seen = await _read()
        ..add(tip.name);
      final file = await _file();
      await file.writeAsString(jsonEncode({'seen': seen.toList()}));
    } catch (_) {
      // Bookkeeping about a hint. Never worth surfacing.
    }
  }

  Future<Set<String>> _read() async {
    final file = await _file();
    if (!await file.exists()) return <String>{};
    final json = jsonDecode(await file.readAsString());
    if (json is! Map<String, dynamic>) return <String>{};
    final seen = json['seen'];
    return seen is List ? seen.whereType<String>().toSet() : <String>{};
  }

  Future<File> _file() async {
    final directory = await storage.rootDirectory();
    return File('${directory.path}/$_filename');
  }
}

final readerCoachStoreProvider = Provider<ReaderCoachStore>(
  (ref) => FileReaderCoachStore(storage: ReaderStorage()),
);

/// The hint itself: a small dark card above the bottom bar.
///
/// Dark whichever theme the app is in, like a snackbar, so it reads as a note
/// laid over the book rather than as part of it. It goes away on its own after
/// [lingerFor] — the reader was not asked a question — and on "Got it".
class ReaderCoachCard extends StatefulWidget {
  const ReaderCoachCard({required this.onDismiss, super.key});

  final VoidCallback onDismiss;

  static const lingerFor = Duration(seconds: 12);

  @override
  State<ReaderCoachCard> createState() => _ReaderCoachCardState();
}

class _ReaderCoachCardState extends State<ReaderCoachCard> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer(ReaderCoachCard.lingerFor, widget.onDismiss);
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return AppEntrance(
      offset: 10,
      child: Semantics(
        container: true,
        liveRegion: true,
        child: Material(
          color: colors.inverseSurface,
          elevation: 4,
          borderRadius: BorderRadius.circular(AppRadii.control),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(
              AppSpacing.md,
              AppSpacing.sm,
              AppSpacing.xs,
              AppSpacing.sm,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: ExcludeSemantics(
                    child: Icon(
                      Icons.touch_app_outlined,
                      size: 22,
                      color: colors.onInverseSurface,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Tap the page to hide the controls',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: colors.onInverseSurface,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Press and hold a word to highlight it, ask about it '
                        'or rewrite it.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.onInverseSurface.withValues(alpha: 0.8),
                        ),
                      ),
                    ],
                  ),
                ),
                TextButton(
                  onPressed: widget.onDismiss,
                  style: TextButton.styleFrom(
                    foregroundColor: colors.inversePrimary,
                    minimumSize: const Size(
                      AppSizes.minimumTouchTarget,
                      AppSizes.minimumTouchTarget,
                    ),
                  ),
                  child: const Text('Got it'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
