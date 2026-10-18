part of 'creation_chat_controller.dart';

/// The chat's series link: a "Write the next book" start, and the answer to
/// the offer the server makes once a mentioned character already appears in
/// one of the reader's finished books (`creation_chat_series.dart` draws it).
mixin CreationChatSeriesActions on Notifier<CreationChatState> {
  // Provided by the controller this mixin is applied to.
  CreationRepository get _repository;
  CreationConversationCache get _cache;
  void _applyConversation(
    MobileCreationConversationResponse response, {
    bool? assistantTyping,
  });

  /// "Write the next book": the earlier book's format applied the way a
  /// remix's is, and the link held until the first message starts the
  /// session — nothing is sent from the button itself.
  void applySeriesStart(BookSeriesStart start) {
    state = state.copyWith(
      presets: start.chatPresets,
      userChoices: {...state.userChoices, ..._formatChoices},
      pendingSeries: PendingBookSeries(
        projectId: start.projectId,
        title: start.title,
        mode: BookSeriesMode.continuation,
      ),
    );
  }

  /// Answers the series offer: link the book this chat builds to [book] as
  /// [mode], or (standalone) to nothing. Before there is a session the answer
  /// is held and rides the request that starts it. A failure is rethrown for
  /// the screen to report; the offer stays open.
  ///
  /// The answer moves the session's revision, so it is never sent beside a
  /// message or a Build, and while it runs it is busy itself
  /// ([CreationChatState.isBusy]) so neither starts beside it: the response is
  /// then the whole conversation, safe to apply as it stands.
  Future<void> chooseSeries(
    BookSeriesMode mode, {
    MobileCreationSeriesBook? book,
  }) async {
    final draftId = state.draftId;
    if (draftId == null) {
      final pending = state.pendingSeries;
      if (pending == null && book == null) return;
      state = state.copyWith(
        pendingSeries: PendingBookSeries(
          projectId: book?.projectId ?? pending!.projectId,
          title: book?.title ?? pending!.title,
          mode: mode,
        ),
      );
      return;
    }
    if (state.isBusy) return;
    state = state.copyWith(seriesBusy: true);
    // The answer is written whether or not this screen is still open.
    final keepAliveLink = ref.keepAlive();
    try {
      final answer = await _repository.chooseSeries(
        draftId: draftId,
        mode: mode,
        projectId: mode.linksBook ? book?.projectId : null,
      );
      _cache.write(answer.response);
      if (state.draftId == draftId) {
        _applyConversation(answer.response, assistantTyping: false);
        final format = answer.chatFormat;
        if (format != null) _adoptSeriesFormat(format);
      }
    } finally {
      state = state.copyWith(seriesBusy: false);
      keepAliveLink.close();
    }
  }

  /// The linked book's format on every setting the reader has not chosen;
  /// then all of them count as chosen, as after a remix, so the next turn
  /// keeps what was adopted and every request sends it.
  void _adoptSeriesFormat(MobileCreationPresets format) {
    final chosen = state.userChoices;
    state = state.copyWith(
      presets: adoptSeriesFormat(
        current: state.presets,
        format: format,
        bookTypeChosen: chosen.contains(CreationChoice.bookType),
        lengthChosen: chosen.contains(CreationChoice.length),
        finishChosen: chosen.contains(CreationChoice.finish),
        coverChosen: chosen.contains(CreationChoice.cover),
        illustrationsChosen: chosen.contains(CreationChoice.illustrations),
      ),
      userChoices: {...chosen, ..._formatChoices},
    );
  }
}

/// The settings a book's format decides.
const _formatChoices = {
  CreationChoice.bookType,
  CreationChoice.length,
  CreationChoice.finish,
  CreationChoice.cover,
  CreationChoice.illustrations,
};
