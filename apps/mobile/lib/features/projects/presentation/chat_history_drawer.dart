import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../data/creation_repository.dart';
import '../data/projects_repository.dart';
import '../domain/creation_models.dart';
import 'projects_home_screen.dart';

class ChatHistoryDrawer extends ConsumerWidget {
  const ChatHistoryDrawer({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(chatSessionsProvider);
    final billing = ref.watch(billingProvider);
    final colors = Theme.of(context).colorScheme;

    return Drawer(
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _DrawerHeader(colors: colors),
            _NewBookButton(colors: colors),
            const SizedBox(height: 8),
            Expanded(
              child: sessions.when(
                data: (items) => _ChatList(sessions: items),
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (_, _) => Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    'Could not load your chats.',
                    style: TextStyle(color: colors.onSurfaceVariant),
                  ),
                ),
              ),
            ),
            const Divider(height: 1),
            _DrawerFooter(billing: billing, colors: colors),
          ],
        ),
      ),
    );
  }
}

class _DrawerHeader extends StatelessWidget {
  const _DrawerHeader({required this.colors});

  final ColorScheme colors;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
      child: Row(
        children: [
          Icon(Icons.auto_stories, color: colors.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              'Tomeza',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
          IconButton(
            tooltip: 'Close',
            icon: const Icon(Icons.close),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}

class _NewBookButton extends StatelessWidget {
  const _NewBookButton({required this.colors});

  final ColorScheme colors;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: FilledButton.tonalIcon(
        onPressed: () {
          Navigator.of(context).pop();
          context.go('/books/new?fresh=true');
        },
        icon: const Icon(Icons.edit_outlined),
        label: const Text('New book'),
        style: FilledButton.styleFrom(alignment: Alignment.centerLeft),
      ),
    );
  }
}

class _GroupData {
  const _GroupData({required this.label, required this.sessions});
  final String label;
  final List<MobileChatSession> sessions;
}

List<_GroupData> _groupByDate(List<MobileChatSession> sorted) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final yesterday = today.subtract(const Duration(days: 1));
  final sevenDaysAgo = today.subtract(const Duration(days: 7));

  final todayItems = <MobileChatSession>[];
  final yesterdayItems = <MobileChatSession>[];
  final last7Items = <MobileChatSession>[];
  final olderItems = <MobileChatSession>[];

  for (final s in sorted) {
    final date = DateTime(s.updatedAt.year, s.updatedAt.month, s.updatedAt.day);
    if (!date.isBefore(today)) {
      todayItems.add(s);
    } else if (!date.isBefore(yesterday)) {
      yesterdayItems.add(s);
    } else if (!date.isBefore(sevenDaysAgo)) {
      last7Items.add(s);
    } else {
      olderItems.add(s);
    }
  }

  return [
    if (todayItems.isNotEmpty) _GroupData(label: 'Today', sessions: todayItems),
    if (yesterdayItems.isNotEmpty)
      _GroupData(label: 'Yesterday', sessions: yesterdayItems),
    if (last7Items.isNotEmpty)
      _GroupData(label: 'Last 7 days', sessions: last7Items),
    if (olderItems.isNotEmpty) _GroupData(label: 'Older', sessions: olderItems),
  ];
}

class _ChatList extends StatelessWidget {
  const _ChatList({required this.sessions});

  final List<MobileChatSession> sessions;

  @override
  Widget build(BuildContext context) {
    if (sessions.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Text(
          'No chats yet. Start your first book.',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }

    final groups = _groupByDate(sessions);

    return ListView.builder(
      padding: EdgeInsets.zero,
      itemCount: groups.length,
      itemBuilder: (context, index) {
        final group = groups[index];
        return _ChatGroup(label: group.label, sessions: group.sessions);
      },
    );
  }
}

class _ChatGroup extends StatelessWidget {
  const _ChatGroup({required this.label, required this.sessions});

  final String label;
  final List<MobileChatSession> sessions;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Text(
            label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: colors.onSurfaceVariant,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
            ),
          ),
        ),
        for (final session in sessions) _ChatTile(session: session),
      ],
    );
  }
}

class _ChatTile extends ConsumerWidget {
  const _ChatTile({required this.session});

  final MobileChatSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final hasProject = session.createdProjectId != null;

    return ListTile(
      dense: true,
      leading: Icon(
        hasProject ? Icons.auto_stories_outlined : Icons.chat_bubble_outline,
        size: 20,
        color: colors.onSurfaceVariant,
      ),
      title: Text(
        session.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.bodyMedium,
      ),
      subtitle: session.preview.isNotEmpty
          ? Text(
              session.preview,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(
                context,
              ).textTheme.labelSmall?.copyWith(color: colors.onSurfaceVariant),
            )
          : null,
      onTap: () => _open(context, ref),
    );
  }

  void _open(BuildContext context, WidgetRef ref) {
    Navigator.of(context).pop();
    final projectId = session.createdProjectId;
    if (projectId != null) {
      // Chat resulted in a project — open it via the project action routing.
      final projects = ref.read(projectsProvider).asData?.value;
      final project = projects?.where((p) => p.id == projectId).firstOrNull;
      if (project != null) {
        context.push(ProjectHomeAction.forProject(project).pathFor(project));
      } else {
        context.push('/projects/$projectId');
      }
    } else {
      // Active chat — open its specific session by draftId.
      context.go('/books/chat/${session.draftId}');
    }
  }
}

class _DrawerFooter extends StatelessWidget {
  const _DrawerFooter({required this.billing, required this.colors});

  final AsyncValue<MobileBilling> billing;
  final ColorScheme colors;

  @override
  Widget build(BuildContext context) {
    final creditLabel = billing.whenOrNull(
      data: (b) => '${b.credits.available} credits',
    );

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      child: Row(
        children: [
          TextButton.icon(
            onPressed: () {
              Navigator.of(context).pop();
              context.push('/account');
            },
            icon: const Icon(Icons.account_circle_outlined),
            label: const Text('Account'),
          ),
          if (creditLabel != null) ...[
            const Spacer(),
            Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Text(
                creditLabel,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
