import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../projects/data/creation_repository.dart';
import '../../projects/domain/creation_models.dart';
import '../../projects/presentation/chat_archive_feedback.dart';

class ArchivedChatsScreen extends ConsumerWidget {
  const ArchivedChatsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(archivedChatSessionsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Archived chats')),
      body: sessions.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => AppErrorState(
          title: 'Archived chats unavailable',
          message: 'Could not load your archived chats.',
          onRetry: () => ref.invalidate(archivedChatSessionsProvider),
        ),
        data: (items) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(archivedChatSessionsProvider);
            try {
              await ref.read(archivedChatSessionsProvider.future);
            } catch (_) {
              // The provider displays the fetch error with a retry action.
            }
          },
          child: items.isEmpty
              ? LayoutBuilder(
                  builder: (context, constraints) => SingleChildScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        minHeight: constraints.maxHeight,
                      ),
                      child: const AppEmptyState(
                        title: 'No archived chats',
                        message:
                            'Press and hold a chat in the sidebar to archive it.',
                        icon: Icons.archive_outlined,
                      ),
                    ),
                  ),
                )
              : ListView.separated(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  itemCount: items.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, index) => _ArchivedChatTile(
                    key: ValueKey(items[index].draftId),
                    session: items[index],
                  ),
                ),
        ),
      ),
    );
  }
}

class _ArchivedChatTile extends ConsumerStatefulWidget {
  const _ArchivedChatTile({required this.session, super.key});

  final MobileChatSession session;

  @override
  ConsumerState<_ArchivedChatTile> createState() => _ArchivedChatTileState();
}

class _ArchivedChatTileState extends ConsumerState<_ArchivedChatTile> {
  bool _restoring = false;

  @override
  Widget build(BuildContext context) {
    final session = widget.session;
    return ListTile(
      leading: const Icon(Icons.chat_bubble_outline),
      title: Text(session.title, maxLines: 2, overflow: TextOverflow.ellipsis),
      subtitle: session.preview.isEmpty
          ? null
          : Text(session.preview, maxLines: 2, overflow: TextOverflow.ellipsis),
      onTap: () {
        AppHaptics.tap();
        context.go('/books/chat/${session.draftId}');
      },
      trailing: _restoring
          ? const SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : IconButton(
              tooltip: 'Unarchive chat',
              icon: const Icon(Icons.unarchive_outlined),
              onPressed: _unarchive,
            ),
    );
  }

  Future<void> _unarchive() async {
    if (_restoring) return;
    setState(() => _restoring = true);
    AppHaptics.tap();
    try {
      await setChatArchivedWithFeedback(
        ref: ref,
        messenger: ScaffoldMessenger.of(context),
        draftId: widget.session.draftId,
        archived: false,
      );
    } finally {
      if (mounted) setState(() => _restoring = false);
    }
  }
}
