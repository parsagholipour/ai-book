/// What one applied edit did to the book, page by page.
///
/// The server diffs the before/after snapshots it already keeps for undo, so
/// reviewing an edit costs nothing and never touches the book.
class MobileEditChanges {
  const MobileEditChanges({
    required this.operationId,
    required this.kind,
    required this.status,
    required this.request,
    required this.creditsCharged,
    required this.pages,
    required this.addedWords,
    required this.removedWords,
    this.appliedAt,
    this.undone = false,
  });

  final String operationId;
  final String kind;
  final String status;

  /// What the user asked for, in their own words.
  final String request;
  final int creditsCharged;
  final DateTime? appliedAt;

  /// True when this edit was rolled back after it was applied.
  final bool undone;

  /// Only the pages the edit actually changed.
  final List<MobileEditPageChange> pages;
  final int addedWords;
  final int removedWords;

  bool get isEmpty => pages.isEmpty;

  factory MobileEditChanges.fromJson(Map<String, dynamic> json) {
    final pages = json['pages'] as List<dynamic>? ?? const [];
    return MobileEditChanges(
      operationId: json['operationId'] as String,
      kind: json['kind'] as String? ?? 'local_patch',
      status: json['status'] as String? ?? 'applied',
      request: json['request'] as String? ?? '',
      creditsCharged: json['creditsCharged'] as int? ?? 0,
      appliedAt: json['appliedAt'] == null
          ? null
          : DateTime.tryParse(json['appliedAt'] as String),
      undone: json['undone'] as bool? ?? false,
      pages: pages
          .map(
            (page) =>
                MobileEditPageChange.fromJson(page as Map<String, dynamic>),
          )
          .toList(),
      addedWords: json['addedWords'] as int? ?? 0,
      removedWords: json['removedWords'] as int? ?? 0,
    );
  }
}

class MobileEditPageChange {
  const MobileEditPageChange({
    required this.pageIndex,
    required this.titleBefore,
    required this.titleAfter,
    required this.titleChanged,
    required this.blocks,
    required this.addedWords,
    required this.removedWords,
  });

  final int pageIndex;
  final String titleBefore;
  final String titleAfter;
  final bool titleChanged;

  /// One entry per paragraph, in reading order — including the untouched ones,
  /// which is the context that makes a change readable.
  final List<MobileEditDiffBlock> blocks;
  final int addedWords;
  final int removedWords;

  factory MobileEditPageChange.fromJson(Map<String, dynamic> json) {
    final blocks = json['blocks'] as List<dynamic>? ?? const [];
    return MobileEditPageChange(
      pageIndex: json['pageIndex'] as int,
      titleBefore: json['titleBefore'] as String? ?? '',
      titleAfter: json['titleAfter'] as String? ?? '',
      titleChanged: json['titleChanged'] as bool? ?? false,
      blocks: blocks
          .map(
            (block) =>
                MobileEditDiffBlock.fromJson(block as Map<String, dynamic>),
          )
          .toList(),
      addedWords: json['addedWords'] as int? ?? 0,
      removedWords: json['removedWords'] as int? ?? 0,
    );
  }
}

enum MobileEditDiffBlockType { unchanged, added, removed, changed }

class MobileEditDiffBlock {
  const MobileEditDiffBlock({required this.type, required this.runs});

  final MobileEditDiffBlockType type;
  final List<MobileEditDiffRun> runs;

  bool get isUnchanged => type == MobileEditDiffBlockType.unchanged;

  /// The paragraph as it reads now, used for the collapsed context summary.
  String get text => runs.map((run) => run.text).join();

  factory MobileEditDiffBlock.fromJson(Map<String, dynamic> json) {
    final runs = json['runs'] as List<dynamic>? ?? const [];
    return MobileEditDiffBlock(
      type: switch (json['type'] as String?) {
        'added' => MobileEditDiffBlockType.added,
        'removed' => MobileEditDiffBlockType.removed,
        'changed' => MobileEditDiffBlockType.changed,
        _ => MobileEditDiffBlockType.unchanged,
      },
      runs: runs
          .map((run) => MobileEditDiffRun.fromJson(run as Map<String, dynamic>))
          .toList(),
    );
  }
}

enum MobileEditDiffRunType { equal, insert, delete }

class MobileEditDiffRun {
  const MobileEditDiffRun({required this.type, required this.text});

  final MobileEditDiffRunType type;
  final String text;

  factory MobileEditDiffRun.fromJson(Map<String, dynamic> json) {
    return MobileEditDiffRun(
      type: switch (json['type'] as String?) {
        'insert' => MobileEditDiffRunType.insert,
        'delete' => MobileEditDiffRunType.delete,
        _ => MobileEditDiffRunType.equal,
      },
      text: json['text'] as String? ?? '',
    );
  }
}
