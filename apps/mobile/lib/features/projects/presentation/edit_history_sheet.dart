import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'credit_cost_badge.dart';
import 'edit_kind_presentation.dart';

/// What the reader picked in the edit history.
///
/// The sheet only answers; the chat that opened it owns the requests, because
/// an undo starts a rebuild and the chat is where that rebuild is shown.
enum EditHistoryChoiceKind { seeChanges, undo, redo, askForChange }

class EditHistoryChoice {
  const EditHistoryChoice(this.kind, [this.operation]);

  final EditHistoryChoiceKind kind;
  final MobileBookEditOperation? operation;
}

/// Opens every edit made to this book, newest first, grouped by day.
Future<EditHistoryChoice?> showEditHistorySheet(
  BuildContext context, {
  required String projectId,
}) {
  return showAppBottomSheet<EditHistoryChoice>(
    context,
    showDragHandle: true,
    builder: (_) => EditHistorySheet(projectId: projectId),
  );
}

/// The book's changes as a timeline.
///
/// Built from the operations the chat already loads, so it costs nothing to
/// open and never disagrees with the cards in the transcript: Undo and Redo are
/// offered exactly where a card would offer them, and See changes only where the
/// server kept a diff.
class EditHistorySheet extends ConsumerWidget {
  const EditHistorySheet({required this.projectId, super.key});

  final String projectId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final chat = ref.watch(projectChatProvider(projectId));
    final height = MediaQuery.sizeOf(context).height * 0.82;
    return SizedBox(
      height: height,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md,
              0,
              AppSpacing.md,
              AppSpacing.xs,
            ),
            child: AppSectionHeader(
              title: 'Edit history',
              subtitle: 'Every change made to this book.',
              titleStyle: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
          Expanded(
            child: chat.when(
              data: (data) => _HistoryBody(
                entries: historyEntries(data.operations),
                messages: data.messages,
              ),
              loading: () => const AppLoadingState(message: 'Loading history'),
              error: (error, stackTrace) => AppErrorState(
                title: 'History unavailable',
                message: userFacingError(error),
                onRetry: () => ref.invalidate(projectChatProvider(projectId)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The operations worth listing, newest first.
///
/// A cancelled operation changed nothing and would only be noise beside the
/// edits that did.
List<MobileBookEditOperation> historyEntries(
  List<MobileBookEditOperation> operations,
) {
  final shown = [
    for (final operation in operations)
      if (operation.status != 'canceled') operation,
  ]..sort((a, b) => b.createdAt.compareTo(a.createdAt));
  return shown;
}

class _HistoryBody extends StatelessWidget {
  const _HistoryBody({required this.entries, required this.messages});

  final List<MobileBookEditOperation> entries;
  final List<MobileProjectChatMessage> messages;

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) {
      return ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          AppEmptyState(
            title: 'No edits yet',
            message:
                'When you change your book by chatting, every edit lands here '
                'with a way to review or undo it.',
            icon: Icons.history,
            actionLabel: 'Ask for a change',
            onAction: () => Navigator.of(
              context,
            ).pop(const EditHistoryChoice(EditHistoryChoiceKind.askForChange)),
          ),
        ],
      );
    }

    // One flat list of day headings and entries, so the whole timeline is a
    // single lazily built scroll rather than a column of columns.
    final rows = <Object>[];
    String? lastDay;
    for (final entry in entries) {
      final day = describeEditDay(context, entry.createdAt);
      if (day != lastDay) {
        rows.add(day);
        lastDay = day;
      }
      rows.add(entry);
    }
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        AppSpacing.xs,
        AppSpacing.md,
        AppSpacing.lg,
      ),
      itemCount: rows.length,
      itemBuilder: (context, index) {
        final row = rows[index];
        if (row is String) {
          return Padding(
            padding: EdgeInsets.only(
              top: index == 0 ? 0 : AppSpacing.md,
              bottom: AppSpacing.xs,
            ),
            child: Semantics(
              header: true,
              child: Text(
                row,
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          );
        }
        final operation = row as MobileBookEditOperation;
        return Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.xs),
          child: _HistoryEntry(
            operation: operation,
            request: _requestFor(operation, messages),
          ),
        );
      },
    );
  }
}

/// What the reader asked for, in their words, when the row can say.
///
/// The operation carries the text only on newer servers; older rows are found
/// through the message they hang under — the reader's own turn, or the reply
/// that answered it.
String? _requestFor(
  MobileBookEditOperation operation,
  List<MobileProjectChatMessage> messages,
) {
  final own = operation.submittedText?.trim();
  if (own != null && own.isNotEmpty) return own;
  final anchorId = operation.anchorMessageId;
  if (anchorId == null) return null;
  final byId = {for (final message in messages) message.id: message};
  var message = byId[anchorId];
  if (message != null && message.isAssistant) {
    message = byId[message.parentId];
  }
  if (message == null || !message.isUser) return null;
  final text = message.content.trim();
  return text.isEmpty ? null : text;
}

class _HistoryEntry extends StatelessWidget {
  const _HistoryEntry({required this.operation, required this.request});

  final MobileBookEditOperation operation;
  final String? request;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final style = editKindStyle(operation.kind);
    final pages = operationPageNumbers(operation);
    final failed = operation.isFailed && !operation.isAutomaticRetryPending;
    final running = operation.isRunning;
    // An applied edit that Redo would put back is one the reader undid.
    final undone = operation.isApplied && operation.canRedo;
    final refunded = operation.effectiveCreditsRefundedAmount;

    final (label, tone, icon) = failed
        ? ('Did not finish', AppTone.error, Icons.error_outline)
        : running
        ? ('In progress', AppTone.info, Icons.autorenew)
        : undone
        ? ('Undone', AppTone.neutral, Icons.undo)
        : ('Applied', AppTone.success, Icons.check);

    void choose(EditHistoryChoiceKind kind) =>
        Navigator.of(context).pop(EditHistoryChoice(kind, operation));

    final canSee = operation.isApplied && operation.changesAvailable;
    final canUndo = operation.isApplied && operation.canUndo;
    final canRedo = operation.isApplied && operation.canRedo;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.sm + 2),
      decoration: BoxDecoration(
        color: undone
            ? colors.surfaceContainerLow
            : colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: Border.all(
          color: failed
              ? colors.error.withValues(alpha: 0.4)
              : colors.outlineVariant,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(
                child: Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: colors.surfaceContainerHigh,
                    borderRadius: BorderRadius.circular(AppRadii.compact),
                  ),
                  child: Icon(
                    style.icon,
                    size: 20,
                    color: undone
                        ? colors.onSurfaceVariant
                        : colors.onPrimaryContainer.withValues(alpha: 0.9),
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      operation.displayAction,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        height: 1.3,
                        color: undone ? colors.onSurfaceVariant : null,
                      ),
                    ),
                    if (request != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        '“$request”',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                    const SizedBox(height: AppSpacing.xs),
                    Wrap(
                      spacing: AppSpacing.xs,
                      runSpacing: AppSpacing.xs,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        AppStatusBadge(label: label, tone: tone, icon: icon),
                        if (pages.isNotEmpty)
                          AppMetricChip(
                            label: pageChipLabel(pages, maxShown: 3),
                            icon: Icons.description_outlined,
                          ),
                        if (operation.creditsCharged > 0 && refunded == 0)
                          CreditCostBadge(credits: operation.creditsCharged),
                        if (refunded > 0)
                          CreditCostBadge(
                            credits: refunded,
                            kind: CreditCostKind.refunded,
                          ),
                      ],
                    ),
                    const SizedBox(height: AppSpacing.xxs),
                    Text(
                      describeEditWhen(context, operation.createdAt),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (canSee || canUndo || canRedo) ...[
            const SizedBox(height: AppSpacing.xxs),
            Wrap(
              alignment: WrapAlignment.end,
              spacing: AppSpacing.xs,
              children: [
                if (canSee)
                  TextButton.icon(
                    onPressed: () => choose(EditHistoryChoiceKind.seeChanges),
                    icon: const Icon(Icons.difference_outlined),
                    label: const Text('See changes'),
                  ),
                if (canUndo)
                  TextButton.icon(
                    onPressed: () => choose(EditHistoryChoiceKind.undo),
                    icon: const Icon(Icons.undo),
                    label: const Text('Undo'),
                  ),
                if (canRedo)
                  TextButton.icon(
                    onPressed: () => choose(EditHistoryChoiceKind.redo),
                    icon: const Icon(Icons.redo),
                    label: const Text('Redo'),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
