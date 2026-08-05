import '../domain/creation_models.dart';

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
