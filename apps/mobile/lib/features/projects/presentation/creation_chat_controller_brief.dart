part of 'creation_chat_controller.dart';

/// The brief-settings setters — book type, length, finish, images, language,
/// tone, title, author, source notes. Every one is a pure `state` update, so
/// they split out cleanly along the settings seam; anything touching the
/// conversation cache or the repository stays on the controller itself.
mixin CreationChatBriefSetters on Notifier<CreationChatState> {
  void setBookType(String value) {
    final choices = {...state.userChoices};
    if (value == 'auto') {
      choices.remove(CreationChoice.bookType);
    } else {
      choices.add(CreationChoice.bookType);
    }
    state = state.copyWith(
      presets: state.presets.copyWith(
        bookType: productBookTypeForChoice(
          value,
          detectedLane: state.detectedLane,
        ),
        bookTypeChoice: value,
      ),
      userChoices: choices,
    );
  }

  void setLengthPreset(String value) {
    state = state.copyWith(
      presets: state.presets.copyWith(lengthPreset: value),
      userChoices: {...state.userChoices, CreationChoice.length},
    );
  }

  void setPageCountAuto() {
    final choices = {...state.userChoices}..remove(CreationChoice.length);
    state = state.copyWith(
      presets: state.presets.copyWith(
        pageCountMode: 'auto',
        targetPages: null,
        pageCountSource: null,
      ),
      userChoices: choices,
    );
  }

  void setCustomTargetPages(int targetPages, {String source = 'settings'}) {
    if (targetPages < 1 || targetPages > 600) {
      return;
    }
    state = state.copyWith(
      presets: state.presets.copyWith(
        pageCountMode: 'custom',
        targetPages: targetPages,
        pageCountSource: source,
      ),
      userChoices: {...state.userChoices, CreationChoice.length},
    );
  }

  void setQualityPreset(String value) {
    state = state.copyWith(
      presets: state.presets.copyWith(qualityPreset: value),
      userChoices: {...state.userChoices, CreationChoice.finish},
    );
  }

  void setCoverEnabled(bool value) {
    state = state.copyWith(
      presets: state.presets.copyWith(coverEnabled: value),
      userChoices: {...state.userChoices, CreationChoice.cover},
    );
  }

  void setIllustrationsEnabled(bool value) {
    state = state.copyWith(
      presets: state.presets.copyWith(illustrationsEnabled: value),
      userChoices: {...state.userChoices, CreationChoice.illustrations},
    );
  }

  /// Compatibility helper for code that still treats all generated images as
  /// one choice. New UI controls must call the independent setters above.
  @Deprecated('Use setCoverEnabled and setIllustrationsEnabled.')
  void setImagesEnabled(bool value) {
    state = state.copyWith(
      presets: state.presets.copyWith(
        coverEnabled: value,
        illustrationsEnabled: value,
      ),
      userChoices: {
        ...state.userChoices,
        CreationChoice.cover,
        CreationChoice.illustrations,
      },
    );
  }

  void setLanguage(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      return;
    }
    state = state.copyWith(
      language: trimmed,
      userChoices: {...state.userChoices, CreationChoice.language},
    );
  }

  /// An empty value means the reader deselected the tone, so the choice marker
  /// goes with it — same shape as [setBookType] with `auto` and
  /// [setPageCountAuto]. Leaving it behind would badge the field "Your choice"
  /// over a row with nothing selected.
  void setTone(String value) {
    final trimmed = value.trim();
    final choices = {...state.userChoices};
    if (trimmed.isEmpty) {
      choices.remove(CreationChoice.tone);
    } else {
      choices.add(CreationChoice.tone);
    }
    state = state.copyWith(
      optionalDetails: copyOptionalDetails(state.optionalDetails, tone: trimmed),
      userChoices: choices,
    );
  }

  void setTitle(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      state = state.copyWith(
        optionalDetails: copyOptionalDetails(
          state.optionalDetails,
          title: trimmed,
        ),
      );
      return;
    }
    state = state.copyWith(
      optionalDetails: copyOptionalDetails(
        state.optionalDetails,
        title: trimmed,
      ),
      sessionTitle: trimmed,
    );
  }

  void setAuthorName(String value) {
    state = state.copyWith(
      optionalDetails: copyOptionalDetails(
        state.optionalDetails,
        authorName: value.trim(),
      ),
    );
  }

  void setSourceNotes(String value) {
    state = state.copyWith(sourceNotes: value);
  }
}
