import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

class ProjectsHomeScreen extends ConsumerWidget {
  const ProjectsHomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(authControllerProvider).asData?.value;
    final projects = ref.watch(projectsProvider);
    final billing = ref.watch(billingProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Tomeza'),
        actions: [
          IconButton(
            tooltip: 'Log out',
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _refresh(ref),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(18, 8, 18, 32),
          children: [
            Text(
              'Your book projects',
              style: Theme.of(
                context,
              ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 4),
            Text(
              session == null ? 'Signed in' : session.user.displayLabel,
              style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 18),
            billing.when(
              data: (value) => CreditsPanel(billing: value),
              loading: () => const AppLoadingState(message: 'Loading credits'),
              error: (error, stackTrace) => AppErrorState(
                title: 'Credits unavailable',
                message: userFacingError(error),
                onRetry: () => ref.invalidate(billingProvider),
              ),
            ),
            const SizedBox(height: 18),
            _NewBookPlaceholder(),
            const SizedBox(height: 18),
            projects.when(
              data: (items) => ProjectList(projects: items),
              loading: () => const AppLoadingState(message: 'Loading projects'),
              error: (error, stackTrace) => AppErrorState(
                title: 'Projects unavailable',
                message: userFacingError(error),
                onRetry: () => ref.invalidate(projectsProvider),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(projectsProvider);
    ref.invalidate(billingProvider);
    await Future.wait([
      ref.read(projectsProvider.future),
      ref.read(billingProvider.future),
    ]);
  }
}

class CreditsPanel extends StatelessWidget {
  const CreditsPanel({required this.billing, super.key});

  final MobileBilling billing;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.account_balance_wallet_outlined,
                  color: colors.primary,
                ),
                const SizedBox(width: 10),
                Text(
                  'Credits',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const Spacer(),
                Text(
                  '${billing.credits.available}',
                  style: Theme.of(
                    context,
                  ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _MetricChip(
                  label: 'Reserved',
                  value: '${billing.credits.reserved}',
                ),
                _MetricChip(
                  label: 'Spent',
                  value: '${billing.credits.lifetimeSpent}',
                ),
                _MetricChip(
                  label: 'Export unlocks',
                  value: '${billing.activeExportUnlockCount}',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _NewBookPlaceholder extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.primaryContainer,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.primary.withValues(alpha: 0.20)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Start a new book',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      color: colors.onPrimaryContainer,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Book setup is not available in this build.',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: colors.onPrimaryContainer,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            FilledButton.icon(
              onPressed: () {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('New book setup is not available yet.'),
                  ),
                );
              },
              icon: const Icon(Icons.add),
              label: const Text('New'),
            ),
          ],
        ),
      ),
    );
  }
}

class ProjectList extends StatelessWidget {
  const ProjectList({required this.projects, super.key});

  final List<MobileProjectSummary> projects;

  @override
  Widget build(BuildContext context) {
    if (projects.isEmpty) {
      return const AppEmptyState(
        title: 'No books yet',
        message: 'Your saved book projects will appear here.',
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final project in projects) ...[
          ProjectCard(project: project),
          const SizedBox(height: 12),
        ],
      ],
    );
  }
}

class ProjectCard extends StatelessWidget {
  const ProjectCard({required this.project, super.key});

  final MobileProjectSummary project;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final progress = (project.progressPercent / 100).clamp(0.0, 1.0);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: colors.secondaryContainer,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(
                    Icons.menu_book_outlined,
                    color: colors.onSecondaryContainer,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        project.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '${project.bookTypeLabel} · ${project.targetPages} pages',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            LinearProgressIndicator(value: progress),
            const SizedBox(height: 10),
            Text(
              project.statusLabel,
              style: Theme.of(
                context,
              ).textTheme.labelLarge?.copyWith(color: colors.primary),
            ),
            const SizedBox(height: 6),
            Text(
              project.currentAction,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 10),
            Text(
              project.promptPreview,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _MetricChip(
                  label: 'Pages',
                  value: '${project.pageCount}/${project.targetPages}',
                ),
                _MetricChip(label: 'Visuals', value: '${project.imageCount}'),
                _MetricChip(
                  label: 'Exports',
                  value: project.hasReadyExport ? 'Ready' : 'Pending',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _MetricChip extends StatelessWidget {
  const _MetricChip({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        '$label: $value',
        style: Theme.of(context).textTheme.labelMedium,
      ),
    );
  }
}
