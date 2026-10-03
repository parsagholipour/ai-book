/// Preferences the creation flow keeps on the device rather than on the server.
///
/// Everything else about a draft — presets, brief, transcript — lives on the
/// `MobileCreationDraft` row, because it belongs to the book being made. These
/// are about the person making it: they outlive any one draft and mean nothing
/// on another device.
class CreationPrefs {
  const CreationPrefs({
    this.visualsPromptSuppressed = false,
    this.creditWarningSuppressed = false,
  });

  /// Whether the user ticked "Don't ask again" on the book-images dialog.
  ///
  /// Only the suppression is remembered, never the answer — a later build uses
  /// whatever the presets already say; the independent cover and illustration
  /// switches in Advanced settings remain authoritative.
  final bool visualsPromptSuppressed;

  /// Hides the warning only; future builds keep their requested page count.
  final bool creditWarningSuppressed;

  CreationPrefs copyWith({
    bool? visualsPromptSuppressed,
    bool? creditWarningSuppressed,
  }) {
    return CreationPrefs(
      visualsPromptSuppressed:
          visualsPromptSuppressed ?? this.visualsPromptSuppressed,
      creditWarningSuppressed:
          creditWarningSuppressed ?? this.creditWarningSuppressed,
    );
  }

  factory CreationPrefs.fromJson(Map<String, dynamic> json) {
    return CreationPrefs(
      visualsPromptSuppressed:
          json['visualsPromptSuppressed'] as bool? ?? false,
      creditWarningSuppressed:
          json['creditWarningSuppressed'] as bool? ?? false,
    );
  }

  Map<String, dynamic> toJson() => {
    'visualsPromptSuppressed': visualsPromptSuppressed,
    'creditWarningSuppressed': creditWarningSuppressed,
  };
}
