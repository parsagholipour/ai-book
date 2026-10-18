import '../domain/creation_models.dart';

/// One Advanced-settings field changed, the rest carried over.
MobileCreationOptionalDetails copyOptionalDetails(
  MobileCreationOptionalDetails current, {
  String? title,
  String? authorName,
  String? mustInclude,
  String? tone,
}) {
  return MobileCreationOptionalDetails(
    title: title ?? current.title,
    authorName: authorName ?? current.authorName,
    mustInclude: mustInclude ?? current.mustInclude,
    tone: tone ?? current.tone,
  );
}

/// Folds a byline or title the chat captured into the Advanced-settings
/// fields.
///
/// Deliberately not sticky, unlike [mergeStickyCreationPresets]: the server
/// only sends these when the reader stated one in the message just sent, so
/// the newest statement has to win. A sticky guard would let a stale sheet
/// value override a name the assistant just confirmed in chat, and the book
/// would then print a different author than the reply promised.
MobileCreationOptionalDetails mergeChatOptionalDetails(
  MobileCreationOptionalDetails current,
  MobileCreationTurn turn,
) {
  final authorName = turn.authorName?.trim();
  final title = turn.title?.trim();
  if ((authorName == null || authorName.isEmpty) &&
      (title == null || title.isEmpty)) {
    return current;
  }
  return copyOptionalDetails(
    current,
    authorName: (authorName?.isEmpty ?? true) ? null : authorName,
    title: (title?.isEmpty ?? true) ? null : title,
  );
}

/// The earlier book's [format] on the settings the reader has not chosen,
/// when they link this book to it: a sequel is usually the same kind of book,
/// but a setting the reader picked themselves is theirs. The caller marks
/// every setting chosen afterwards, as a remix does, so the next turn keeps
/// what was adopted.
MobileCreationPresets adoptSeriesFormat({
  required MobileCreationPresets current,
  required MobileCreationPresets format,
  required bool bookTypeChosen,
  required bool lengthChosen,
  required bool finishChosen,
  required bool coverChosen,
  required bool illustrationsChosen,
}) {
  return current.copyWith(
    bookType: bookTypeChosen ? null : format.bookType,
    bookTypeChoice: bookTypeChosen ? null : format.bookTypeChoice,
    lengthPreset: lengthChosen ? null : format.lengthPreset,
    pageCountMode: lengthChosen ? null : format.pageCountMode,
    targetPages: lengthChosen ? current.targetPages : format.targetPages,
    pageCountSource: lengthChosen
        ? current.pageCountSource
        : format.pageCountSource,
    qualityPreset: finishChosen ? null : format.qualityPreset,
    coverEnabled: coverChosen ? null : format.coverEnabled,
    illustrationsEnabled: illustrationsChosen
        ? null
        : format.illustrationsEnabled,
  );
}

/// Keeps explicit Advanced-settings choices sticky while accepting real
/// server-side changes made through the creation chat.
MobileCreationPresets mergeStickyCreationPresets({
  required MobileCreationPresets incoming,
  required MobileCreationPresets current,
  required MobileCreationPresets? synced,
  required bool bookTypeChosen,
  required bool lengthChosen,
  required bool finishChosen,
  required bool coverChosen,
  required bool illustrationsChosen,
}) {
  bool serverChanged<T>(T Function(MobileCreationPresets presets) select) {
    return synced != null && select(incoming) != select(synced);
  }

  final keepBookType =
      bookTypeChosen && !serverChanged((presets) => presets.bookTypeChoice);
  final keepLength =
      lengthChosen &&
      !serverChanged(
        (presets) =>
            '${presets.lengthPreset}|${presets.pageCountMode}|${presets.targetPages}',
      );
  final keepFinish =
      finishChosen && !serverChanged((presets) => presets.qualityPreset);
  final keepCover =
      coverChosen && !serverChanged((presets) => presets.coverEnabled);
  final keepIllustrations =
      illustrationsChosen &&
      !serverChanged((presets) => presets.illustrationsEnabled);

  return incoming.copyWith(
    bookType: keepBookType ? current.bookType : null,
    bookTypeChoice: keepBookType ? current.bookTypeChoice : null,
    lengthPreset: keepLength ? current.lengthPreset : null,
    pageCountMode: keepLength ? current.pageCountMode : null,
    targetPages: keepLength ? current.targetPages : incoming.targetPages,
    pageCountSource: keepLength
        ? current.pageCountSource
        : incoming.pageCountSource,
    qualityPreset: keepFinish ? current.qualityPreset : null,
    coverEnabled: keepCover ? current.coverEnabled : null,
    illustrationsEnabled: keepIllustrations
        ? current.illustrationsEnabled
        : null,
  );
}
