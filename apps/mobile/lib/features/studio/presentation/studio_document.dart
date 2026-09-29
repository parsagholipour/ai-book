import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../domain/manuscript_blocks.dart';
import '../domain/manuscript_word_count.dart';
import 'manuscript_editing_controller.dart';

/// One thing in the open chapter, as the editor holds it: a text segment with
/// its own controller, focus and undo history, a picture with an editable
/// caption, a picture still uploading or being drawn by the AI, a chart, or a
/// page break.
///
/// Entries are the editor-side twin of `ManuscriptBlock`s. They own the
/// mutable objects the widgets bind to, so the widgets can come and go
/// (scrolling, a layout switch) without losing a keystroke.
sealed class StudioEntry {
  StudioEntry() : id = _nextId++;

  static int _nextId = 0;

  /// Stable for the entry's life; keys its widget.
  final int id;

  /// The block this entry saves as, or null for one that saves nothing yet.
  ManuscriptBlock? get block;

  void dispose() {}
}

final class StudioTextEntry extends StudioEntry {
  StudioTextEntry(String text)
    : controller = ManuscriptEditingController(text: text),
      _lastText = text,
      words = manuscriptWordCount(text);

  final ManuscriptEditingController controller;
  final FocusNode focusNode = FocusNode(debugLabel: 'studio-text');
  final UndoHistoryController undo = UndoHistoryController();

  /// Words in this segment, recounted when its text (not just its selection)
  /// changes.
  int words;
  String _lastText;

  String get text => controller.text;

  bool get isBlank => controller.text.trim().isEmpty;

  /// Bumped every time the document rewrites this segment wholesale — a
  /// split around a picture, a re-join, a merge. The editor keys the field on
  /// it, so the field's undo history starts over: an undo reaching back past a
  /// split would restore text that now also lives in the next segment, and
  /// the chapter would save it twice.
  int historyEpoch = 0;

  /// Replaces the whole text, leaving the cursor at [cursor] (default: end).
  /// Only the document calls this, for a structural change; an edit the author
  /// should be able to undo goes through [controller] instead.
  void setText(String text, {int? cursor}) {
    historyEpoch += 1;
    controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(
        offset: (cursor ?? text.length).clamp(0, text.length),
      ),
    );
  }

  @override
  ManuscriptBlock get block => TextBlock(controller.text);

  @override
  void dispose() {
    controller.dispose();
    focusNode.dispose();
    undo.dispose();
  }
}

final class StudioImageEntry extends StudioEntry {
  StudioImageEntry(ImageBlock image)
    : url = image.url,
      title = image.title,
      caption = TextEditingController(text: image.alt);

  String url;
  final String? title;
  final TextEditingController caption;
  final FocusNode captionFocus = FocusNode(debugLabel: 'studio-caption');

  @override
  ManuscriptBlock get block =>
      ImageBlock(alt: caption.text.trim(), url: url, title: title);

  @override
  void dispose() {
    caption.dispose();
    captionFocus.dispose();
  }
}

/// A picture on its way to the server. Saves as nothing until it lands.
final class StudioUploadEntry extends StudioEntry {
  StudioUploadEntry(this.bytes, {this.replacing});

  /// The picked bytes, shown dimmed under the progress bar.
  final Uint8List bytes;

  /// The picture this upload replaces: it goes back if the upload fails, and
  /// keeps its caption when it succeeds.
  final StudioImageEntry? replacing;

  /// The whitespace the split took out of the text, so a failed upload can
  /// put the sentence back exactly as it was.
  String? rejoinWith;

  /// 0..1 once the upload reports, null before.
  final ValueNotifier<double?> progress = ValueNotifier(null);

  @override
  ManuscriptBlock? get block => null;

  @override
  void dispose() => progress.dispose();
}

/// Where a picture the AI is drawing stands.
class StudioAiPictureState {
  const StudioAiPictureState.drawing() : failure = null, starting = false;

  /// Asking the server to try again.
  const StudioAiPictureState.starting() : failure = null, starting = true;

  const StudioAiPictureState.failed(String this.failure) : starting = false;

  /// Why it could not be drawn, in a sentence for the author.
  final String? failure;
  final bool starting;

  bool get failed => failure != null;
}

/// A picture the AI is drawing: a placeholder in the text that saves as
/// nothing — so a chapter saved meanwhile is the chapter without it — and
/// becomes a real picture when the drawing lands.
final class StudioAiPictureEntry extends StudioEntry {
  StudioAiPictureEntry({
    required this.assistId,
    required this.prompt,
    required this.passage,
  });

  /// The background request drawing it. A retry is a new request.
  String assistId;

  /// What the picture shows, as the author confirmed it.
  final String prompt;

  /// The text it illustrates.
  final String passage;

  /// The whitespace the split took out of the text, so removing the
  /// placeholder puts the text back exactly as it was.
  String? rejoinWith;

  final ValueNotifier<StudioAiPictureState> state = ValueNotifier(
    const StudioAiPictureState.drawing(),
  );

  @override
  ManuscriptBlock? get block => null;

  @override
  void dispose() => state.dispose();
}

final class StudioFigureEntry extends StudioEntry {
  StudioFigureEntry(this.figure);

  final FigureBlock figure;

  @override
  ManuscriptBlock get block => figure;
}

final class StudioPageBreakEntry extends StudioEntry {
  @override
  ManuscriptBlock get block => const PageBreakBlock();
}

/// One page of a picture book: the entries between two page breaks.
class StudioPage {
  const StudioPage({required this.index, required this.entries});

  /// 0-based.
  final int index;
  final List<StudioEntry> entries;

  /// The picture slot: the page's first entry, when it is a picture (or one
  /// on its way).
  StudioEntry? get picture {
    final first = entries.isEmpty ? null : entries.first;
    return first is StudioImageEntry ||
            first is StudioUploadEntry ||
            first is StudioAiPictureEntry
        ? first
        : null;
  }

  /// The page's words, as the author typed them.
  String get text => [
    for (final entry in body)
      if (entry is StudioTextEntry && !entry.isBlank) entry.text.trim(),
  ].join('\n\n');

  /// Everything below the picture slot.
  List<StudioEntry> get body => picture == null ? entries : entries.sublist(1);

  StudioTextEntry? get firstText {
    for (final entry in entries) {
      if (entry is StudioTextEntry) return entry;
    }
    return null;
  }
}

/// The open chapter as the editor edits it: the title and the entries.
///
/// It speaks markdown at both ends — built from a chapter's markdown, and
/// [markdown] serializes it back through `serializeManuscriptBlocks` — and
/// in between it only rearranges entries. Keystrokes never notify this
/// object's listeners (the fields repaint themselves); they call [onEdited]
/// so the session can mark the chapter dirty and schedule a save. Structural
/// changes — a picture in, a page out — notify, and the editor rebuilds.
///
/// Its invariants, restored after every structural change by [_normalize]:
/// no two text entries are adjacent (they merge), there is a text entry to
/// type in after every picture and at the end, and in the picture layout
/// every page has one.
class StudioDocument extends ChangeNotifier {
  StudioDocument({
    required String title,
    required String markdown,
    required this._picture,
    required this.onEdited,
    required this.onFocusChanged,
  }) : title = TextEditingController(text: title) {
    this.title.addListener(_titleChanged);
    _lastTitle = title;
    _entries = _entriesFor(markdown);
    _normalize();
  }

  final TextEditingController title;
  final FocusNode titleFocus = FocusNode(debugLabel: 'studio-title');

  /// A keystroke or a structural change altered what would be saved.
  final VoidCallback onEdited;

  /// A text segment gained focus (or the last one lost it: null).
  final ValueChanged<StudioTextEntry?> onFocusChanged;

  late List<StudioEntry> _entries;
  late String _lastTitle;
  bool _picture;
  bool _disposed = false;

  List<StudioEntry> get entries => List.unmodifiable(_entries);

  bool get isPictureLayout => _picture;

  set isPictureLayout(bool value) {
    if (value == _picture) return;
    _picture = value;
    _normalize();
    notifyListeners();
  }

  /// The chapter as it would be saved now.
  String get markdown =>
      serializeManuscriptBlocks([for (final entry in _entries) ?entry.block]);

  int get words => _entries.whereType<StudioTextEntry>().fold(
    0,
    (sum, entry) => sum + entry.words,
  );

  bool get hasUploads => _entries.any((entry) => entry is StudioUploadEntry);

  Iterable<StudioTextEntry> get textEntries =>
      _entries.whereType<StudioTextEntry>();

  StudioTextEntry get lastText => textEntries.last;

  /// The picture layout's pages. A flow chapter is one page.
  List<StudioPage> get pages {
    final pages = <StudioPage>[];
    var current = <StudioEntry>[];
    for (final entry in _entries) {
      if (entry is StudioPageBreakEntry) {
        pages.add(StudioPage(index: pages.length, entries: current));
        current = [];
      } else {
        current.add(entry);
      }
    }
    pages.add(StudioPage(index: pages.length, entries: current));
    return pages;
  }

  /// Swaps in other text wholesale: a version restored, the server's copy
  /// chosen in a conflict. Focus and undo histories start over.
  void replaceContent({required String title, required String markdown}) {
    final old = _entries;
    _entries = _entriesFor(markdown);
    _normalize();
    if (this.title.text != title) this.title.text = title;
    _lastTitle = title;
    _disposeLater(old);
    notifyListeners();
    onEdited();
  }

  // ---------------------------------------------------------------------------
  // Pictures

  /// Splits [target] at [offset] and puts an uploading picture between the two
  /// halves. With no target the picture goes at the end of the chapter.
  StudioUploadEntry insertUpload(
    Uint8List bytes, {
    StudioTextEntry? target,
    int? offset,
  }) {
    final upload = StudioUploadEntry(bytes);
    upload.rejoinWith = _splitAround(target ?? lastText, offset, upload);
    _structureChanged();
    return upload;
  }

  /// Splits [text] at [offset] (default: its end) and puts [middle] between
  /// the two halves. Answers the whitespace the split took out.
  String _splitAround(StudioTextEntry text, int? offset, StudioEntry middle) {
    final value = text.controller.text;
    final at = (offset ?? value.length).clamp(0, value.length);
    final before = value.substring(0, at).trimRight();
    final after = value.substring(at).replaceFirst(RegExp(r'^\s+'), '');
    final rejoin = value.substring(before.length, value.length - after.length);
    final index = _entries.indexOf(text);
    text.setText(before);
    _entries.insertAll(index + 1, [middle, StudioTextEntry(after)]);
    return rejoin;
  }

  bool contains(StudioEntry entry) => _entries.contains(entry);

  // ---------------------------------------------------------------------------
  // Pictures the AI is drawing

  /// Puts a picture the AI is drawing into [target] at [offset] — a paragraph
  /// boundary, so the chapter saves exactly as before while it is drawn.
  StudioAiPictureEntry insertAiPicture(
    StudioTextEntry target,
    int offset, {
    required String assistId,
    required String prompt,
    required String passage,
  }) {
    final picture = StudioAiPictureEntry(
      assistId: assistId,
      prompt: prompt,
      passage: passage,
    );
    picture.rejoinWith = _splitAround(target, offset, picture);
    _structureChanged();
    return picture;
  }

  /// Puts a picture the AI is drawing in page [pageIndex]'s picture slot.
  StudioAiPictureEntry insertPageAiPicture(
    int pageIndex, {
    required String assistId,
    required String prompt,
    required String passage,
  }) {
    final page = pages[pageIndex];
    final picture = StudioAiPictureEntry(
      assistId: assistId,
      prompt: prompt,
      passage: passage,
    );
    final anchor = page.entries.isEmpty ? null : page.entries.first;
    final index = anchor == null
        ? _pageStartIndex(pageIndex)
        : _entries.indexOf(anchor);
    _entries.insert(index, picture);
    _structureChanged();
    return picture;
  }

  /// The drawing landed: the placeholder becomes a picture like any other.
  StudioImageEntry landAiPicture(
    StudioAiPictureEntry picture, {
    required String url,
    required String alt,
  }) {
    final image = StudioImageEntry(ImageBlock(alt: alt, url: url));
    final index = _entries.indexOf(picture);
    if (index < 0) return image;
    _entries[index] = image;
    _attach(image);
    _disposeLater([picture]);
    _structureChanged();
    return image;
  }

  /// Takes a placeholder out; a split closes up again.
  void removeAiPicture(StudioAiPictureEntry picture) {
    _removePlaceholder(picture, picture.rejoinWith);
  }

  /// The first page with no picture and no picture on its way, or null.
  int? get firstEmptyPictureSlot {
    for (final page in pages) {
      if (page.picture == null) return page.index;
    }
    return null;
  }

  /// Puts an uploading picture in page [pageIndex]'s picture slot.
  StudioUploadEntry insertPagePictureUpload(int pageIndex, Uint8List bytes) {
    final page = pages[pageIndex];
    final upload = StudioUploadEntry(bytes);
    final anchor = page.entries.isEmpty ? null : page.entries.first;
    final index = anchor == null
        ? _pageStartIndex(pageIndex)
        : _entries.indexOf(anchor);
    _entries.insert(index, upload);
    _structureChanged();
    return upload;
  }

  /// Stands an upload in for [image] while its replacement goes up.
  StudioUploadEntry beginReplace(StudioImageEntry image, Uint8List bytes) {
    final upload = StudioUploadEntry(bytes, replacing: image);
    final index = _entries.indexOf(image);
    if (index < 0) return upload;
    _entries[index] = upload;
    _structureChanged();
    return upload;
  }

  /// The upload landed: it becomes a picture. A new picture's caption takes
  /// focus; a replaced one keeps its caption.
  StudioImageEntry completeUpload(StudioUploadEntry upload, String url) {
    final replacing = upload.replacing;
    final image = replacing ?? StudioImageEntry(ImageBlock(alt: '', url: url));
    image.url = url;
    final index = _entries.indexOf(upload);
    if (index < 0) return image;
    _entries[index] = image;
    _disposeLater([upload]);
    _structureChanged();
    if (replacing == null) _focusSoon(image.captionFocus);
    return image;
  }

  /// The upload failed or was abandoned: a replaced picture comes back, a
  /// new one's split closes up again.
  void cancelUpload(StudioUploadEntry upload) {
    final index = _entries.indexOf(upload);
    if (index < 0) return;
    final replacing = upload.replacing;
    if (replacing == null) {
      _removePlaceholder(upload, upload.rejoinWith);
      return;
    }
    _entries[index] = replacing;
    _disposeLater([upload]);
    _structureChanged();
  }

  /// Takes out an entry that saves as nothing; when it split a text segment,
  /// the two halves join up with the whitespace the split took.
  void _removePlaceholder(StudioEntry placeholder, String? rejoin) {
    final index = _entries.indexOf(placeholder);
    if (index < 0) return;
    final gone = <StudioEntry>[placeholder];
    final previous = index > 0 ? _entries[index - 1] : null;
    final next = index + 1 < _entries.length ? _entries[index + 1] : null;
    if (rejoin != null &&
        previous is StudioTextEntry &&
        next is StudioTextEntry) {
      final cursor = previous.text.length + rejoin.length;
      previous.setText('${previous.text}$rejoin${next.text}', cursor: cursor);
      _entries.removeRange(index, index + 2);
      gone.add(next);
    } else {
      _entries.removeAt(index);
    }
    _disposeLater(gone);
    _structureChanged();
  }

  bool canMoveUp(StudioEntry entry) {
    final index = _entries.indexOf(entry);
    return _entries
        .take(index < 0 ? 0 : index)
        .any((e) => e is! StudioTextEntry || !e.isBlank);
  }

  bool canMoveDown(StudioEntry entry) {
    final index = _entries.indexOf(entry);
    return index >= 0 &&
        _entries
            .skip(index + 1)
            .any((e) => e is! StudioTextEntry || !e.isBlank);
  }

  /// Moves a picture (or chart) one paragraph up or down. Past an empty gap
  /// it trades places with the picture on the other side instead.
  void moveEntry(StudioEntry entry, {required bool up}) {
    final index = _entries.indexOf(entry);
    if (index < 0) return;
    final neighbourIndex = up ? index - 1 : index + 1;
    if (neighbourIndex < 0 || neighbourIndex >= _entries.length) return;
    final neighbour = _entries[neighbourIndex];
    if (neighbour is StudioTextEntry && !neighbour.isBlank) {
      final paragraphs = splitManuscriptParagraphs(neighbour.text);
      final moved = up ? paragraphs.removeLast() : paragraphs.removeAt(0);
      neighbour.setText(paragraphs.join('\n\n'));
      final otherIndex = up ? index + 1 : index - 1;
      final other = otherIndex >= 0 && otherIndex < _entries.length
          ? _entries[otherIndex]
          : null;
      if (other is StudioTextEntry) {
        other.setText(
          up ? _join(moved, other.text) : _join(other.text, moved),
          cursor: up ? 0 : null,
        );
      } else {
        _entries.insert(up ? index + 1 : index, StudioTextEntry(moved));
      }
    } else {
      final swapIndex = up ? index - 2 : index + 2;
      if (swapIndex < 0 || swapIndex >= _entries.length) return;
      final swap = _entries[swapIndex];
      if (swap is StudioTextEntry || swap is StudioPageBreakEntry) return;
      _entries[swapIndex] = entry;
      _entries[index] = swap;
    }
    _structureChanged();
  }

  /// Takes a picture out; the text above and below it join up.
  void removeEntry(StudioEntry entry) {
    if (!_entries.remove(entry)) return;
    _disposeLater([entry]);
    _structureChanged();
  }

  // ---------------------------------------------------------------------------
  // Picture-book pages

  /// Adds an empty page at the end and returns its text field.
  StudioTextEntry addPage() {
    final text = StudioTextEntry('');
    _entries.addAll([StudioPageBreakEntry(), text]);
    _structureChanged();
    _focusSoon(text.focusNode);
    return text;
  }

  /// Removes page [pageIndex] and returns its blocks, for an undo.
  List<ManuscriptBlock> deletePage(int pageIndex) {
    final all = pages;
    final page = all[pageIndex];
    final removed = [for (final entry in page.entries) ?entry.block];
    final start = _pageStartIndex(pageIndex);
    final end = start + page.entries.length;
    final List<StudioEntry> gone;
    if (all.length == 1) {
      gone = _entries.sublist(0);
      _entries = [StudioTextEntry('')];
    } else if (pageIndex == 0) {
      // The page and the break after it.
      gone = _entries.sublist(start, end + 1);
      _entries.removeRange(start, end + 1);
    } else {
      // The break before the page, and the page.
      gone = _entries.sublist(start - 1, end);
      _entries.removeRange(start - 1, end);
    }
    _disposeLater(gone);
    _structureChanged();
    return removed;
  }

  /// Puts a deleted page back at [pageIndex].
  void restorePage(int pageIndex, List<ManuscriptBlock> blocks) {
    final restored = [
      for (final block in blocks) _entryFor(block),
      if (blocks.isEmpty) StudioTextEntry(''),
    ];
    final count = pages.length;
    if (pageIndex >= count) {
      _entries.addAll([StudioPageBreakEntry(), ...restored]);
    } else {
      final start = _pageStartIndex(pageIndex);
      _entries.insertAll(start, [...restored, StudioPageBreakEntry()]);
    }
    _structureChanged();
  }

  void movePage(int pageIndex, {required bool up}) {
    final all = pages.map((page) => page.entries).toList();
    final target = up ? pageIndex - 1 : pageIndex + 1;
    if (target < 0 || target >= all.length) return;
    final moved = all.removeAt(pageIndex);
    all.insert(target, moved);
    final breaks = _entries.whereType<StudioPageBreakEntry>().toList();
    _entries = [
      for (var i = 0; i < all.length; i++) ...[
        if (i > 0) breaks[i - 1],
        ...all[i],
      ],
    ];
    _structureChanged();
  }

  int _pageStartIndex(int pageIndex) {
    var page = 0;
    for (var i = 0; i < _entries.length; i++) {
      if (page == pageIndex) return i;
      if (_entries[i] is StudioPageBreakEntry) page++;
    }
    return _entries.length;
  }

  // ---------------------------------------------------------------------------

  List<StudioEntry> _entriesFor(String markdown) => [
    for (final block in parseManuscriptBlocks(markdown)) _entryFor(block),
  ];

  StudioEntry _entryFor(ManuscriptBlock block) {
    final entry = switch (block) {
      TextBlock(:final text) => StudioTextEntry(text),
      ImageBlock() => StudioImageEntry(block),
      FigureBlock() => StudioFigureEntry(block),
      PageBreakBlock() => StudioPageBreakEntry(),
    };
    _attach(entry);
    return entry;
  }

  final Set<int> _attached = {};

  void _attach(StudioEntry entry) {
    if (!_attached.add(entry.id)) return;
    switch (entry) {
      case StudioTextEntry():
        entry.controller.addListener(() => _textChanged(entry));
        entry.focusNode.addListener(() {
          if (entry.focusNode.hasFocus) {
            onFocusChanged(entry);
          } else if (!textEntries.any((e) => e.focusNode.hasFocus)) {
            onFocusChanged(null);
          }
        });
      case StudioImageEntry():
        entry.caption.addListener(onEdited);
      case StudioUploadEntry() ||
          StudioAiPictureEntry() ||
          StudioFigureEntry() ||
          StudioPageBreakEntry():
        break;
    }
  }

  void _textChanged(StudioTextEntry entry) {
    final text = entry.controller.text;
    if (text == entry._lastText) return;
    entry._lastText = text;
    entry.words = manuscriptWordCount(text);
    onEdited();
  }

  void _titleChanged() {
    if (title.text == _lastTitle) return;
    _lastTitle = title.text;
    onEdited();
  }

  void _structureChanged() {
    _normalize();
    notifyListeners();
    onEdited();
  }

  /// Restores the invariants in the class comment.
  void _normalize() {
    final result = <StudioEntry>[];
    final merged = <StudioEntry>[];
    for (final entry in _entries) {
      final last = result.isEmpty ? null : result.last;
      if (entry is StudioTextEntry) {
        if (last is StudioTextEntry) {
          final cursorBase = last.text.isEmpty ? 0 : last.text.length + 2;
          final hadFocus = entry.focusNode.hasFocus;
          final joined = _join(last.text, entry.text);
          last.setText(joined);
          merged.add(entry);
          if (hadFocus) {
            final at = entry.controller.selection.baseOffset;
            last.controller.selection = TextSelection.collapsed(
              offset: (cursorBase + (at < 0 ? 0 : at)).clamp(0, joined.length),
            );
            _focusSoon(last.focusNode);
          }
          continue;
        }
        result.add(entry);
        continue;
      }
      if (entry is StudioPageBreakEntry) {
        if (_picture && last is! StudioTextEntry) {
          result.add(_attached0(StudioTextEntry('')));
        }
        result.add(entry);
        continue;
      }
      // A picture, a chart or an upload.
      final opensPage =
          _picture && (last == null || last is StudioPageBreakEntry);
      if (last != null && last is! StudioTextEntry && !opensPage) {
        result.add(_attached0(StudioTextEntry('')));
      } else if (last == null && !_picture) {
        result.add(_attached0(StudioTextEntry('')));
      }
      result.add(entry);
    }
    if (result.isEmpty || result.last is! StudioTextEntry) {
      result.add(_attached0(StudioTextEntry('')));
    }
    for (final entry in result) {
      _attach(entry);
    }
    _entries = result;
    _disposeLater(merged);
  }

  StudioEntry _attached0(StudioEntry entry) {
    _attach(entry);
    return entry;
  }

  static String _join(String a, String b) {
    final first = trimBlankLines(a);
    final second = trimBlankLines(b);
    if (first.isEmpty) return second;
    if (second.isEmpty) return first;
    return '$first\n\n$second';
  }

  void _focusSoon(FocusNode node) {
    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (_disposed) return;
      try {
        node.requestFocus();
      } catch (_) {
        // The entry went away before the frame: nothing to focus.
      }
    });
  }

  /// Entries leave the list now but are disposed after the frame that
  /// unmounts their widgets, which still hold their controllers until then.
  void _disposeLater(List<StudioEntry> entries) {
    if (entries.isEmpty) return;
    SchedulerBinding.instance
      ..addPostFrameCallback((_) {
        for (final entry in entries) {
          _attached.remove(entry.id);
          entry.dispose();
        }
      })
      ..scheduleFrame();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final entry in _entries) {
      if (entry is StudioUploadEntry) entry.replacing?.dispose();
      entry.dispose();
    }
    title.dispose();
    titleFocus.dispose();
    super.dispose();
  }
}
