/// Preferences the creation flow keeps on the device rather than on the server.
///
/// Everything else about a draft — presets, brief, transcript — lives on the
/// `MobileCreationDraft` row, because it belongs to the book being made. These
/// are about the person making it: they outlive any one draft and mean nothing
/// on another device.
class CreationPrefs {
  const CreationPrefs({this.visualsPromptSuppressed = false});

  /// Whether the user ticked "Don't ask again" on the illustrations dialog.
  ///
  /// Only the suppression is remembered, never the answer — a later build uses
  /// whatever the presets already say, which is what the Visuals switch in
  /// Advanced settings edits.
  final bool visualsPromptSuppressed;

  CreationPrefs copyWith({bool? visualsPromptSuppressed}) {
    return CreationPrefs(
      visualsPromptSuppressed:
          visualsPromptSuppressed ?? this.visualsPromptSuppressed,
    );
  }

  factory CreationPrefs.fromJson(Map<String, dynamic> json) {
    return CreationPrefs(
      visualsPromptSuppressed:
          json['visualsPromptSuppressed'] as bool? ?? false,
    );
  }

  Map<String, dynamic> toJson() => {
    'visualsPromptSuppressed': visualsPromptSuppressed,
  };
}
