part of 'creation_chat_screen.dart';

// Opening the conversation this screen was navigated to: a specific chat, the
// one last active, or a fresh one — and a fresh one may start from a shared
// book's format ("Make a book like this").
//
// A remix is set up entirely on this side: the presets are applied and the
// composer's first line is written, and nothing is sent. The reader finishes
// the sentence and taps send like any first message; that send is what starts
// the session (carrying the share's slug, see `CreationChatState.remixSlug`)
// and what spends a message, never the link itself.

mixin _CreationChatStart on ConsumerState<CreationChatScreen> {
  // Provided by the screen this mixin is applied to.
  TextEditingController get _composerController;
  FocusNode get _composerFocusNode;

  void _initConversation({bool force = false}) {
    unawaited(
      Future<void>.microtask(() async {
        if (!mounted) return;
        final controller = ref.read(creationChatControllerProvider.notifier);
        await controller.init(
          fresh: widget.startFresh,
          draftId: widget.draftId,
          force: force,
        );
        final remix = widget.remix;
        if (remix == null || !mounted) return;
        controller.applyRemix(remix);
        _startComposerWith(
          remixComposerPrefill(
            bookTypeChoice: remix.bookTypeChoice,
            title: remix.title,
          ),
        );
      }),
    );
  }

  /// Writes [text] into the composer with the cursor at its end, and puts the
  /// keyboard up once the composer is on screen: the line is there to be
  /// finished.
  void _startComposerWith(String text) {
    _composerController.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _composerFocusNode.requestFocus();
    });
  }
}
