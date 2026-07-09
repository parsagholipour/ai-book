import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
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
            tooltip: 'Account',
            onPressed: () => context.push('/account'),
            icon: const Icon(Icons.account_circle_outlined),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _refresh(ref),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(18, 8, 18, 32),
          children: [
            projects.when(
              data: (items) => _HomeContent(
                displayName: session?.user.displayLabel,
                projects: items,
                billing: billing,
                onStartBook: () => context.push('/books/new'),
                onAddCredits: () => showBillingPaywall(
                  context,
                  title: 'Add book credits',
                  message:
                      'Credits are used when you approve a full book or unlock finished exports.',
                ),
                onRetryBilling: () => ref.invalidate(billingProvider),
              ),
              loading: () => const Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _HomeHeader(
                    title: 'Opening your library',
                    subtitle: 'Checking your saved book projects.',
                  ),
                  SizedBox(height: 18),
                  AppLoadingState(message: 'Loading projects'),
                ],
              ),
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

class _HomeContent extends StatelessWidget {
  const _HomeContent({
    required this.projects,
    required this.billing,
    required this.onStartBook,
    required this.onAddCredits,
    required this.onRetryBilling,
    this.displayName,
  });

  final String? displayName;
  final List<MobileProjectSummary> projects;
  final AsyncValue<MobileBilling> billing;
  final VoidCallback onStartBook;
  final VoidCallback onAddCredits;
  final VoidCallback onRetryBilling;

  @override
  Widget build(BuildContext context) {
    if (projects.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const _HomeHeader(
            title: 'Start your first book',
            subtitle:
                'Describe your idea in a quick chat, then build a book plan you can refine.',
          ),
          const SizedBox(height: 16),
          _FirstProjectCard(onStartBook: onStartBook),
          const SizedBox(height: 14),
          _BillingSummarySlot(
            billing: billing,
            onAddCredits: onAddCredits,
            onRetry: onRetryBilling,
          ),
        ],
      );
    }

    final sortedProjects = sortProjectsByNextAction(projects);
    final attentionProjects = sortedProjects
        .where(
          (project) => ProjectHomeAction.forProject(project).needsUserAction,
        )
        .toList();
    final backgroundProjects = sortedProjects
        .where(
          (project) => !ProjectHomeAction.forProject(project).needsUserAction,
        )
        .toList();
    final name = _firstName(displayName);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _HomeHeader(
          title: 'Welcome back, $name',
          subtitle: attentionProjects.isEmpty
              ? 'Your books are sorted by what is useful to open next.'
              : '${attentionProjects.length} ${attentionProjects.length == 1 ? 'book is' : 'books are'} waiting for your input.',
        ),
        const SizedBox(height: 12),
        _SecondaryStartBookAction(onStartBook: onStartBook),
        const SizedBox(height: 18),
        if (attentionProjects.isNotEmpty) ...[
          _ProjectSection(
            title: 'Pick up next',
            subtitle: 'Start with the first book below.',
            projects: attentionProjects,
            featureFirstCard: true,
          ),
          const SizedBox(height: 18),
        ],
        if (backgroundProjects.isNotEmpty) ...[
          _ProjectSection(
            title: attentionProjects.isEmpty
                ? 'Your books'
                : 'Working in the background',
            subtitle: attentionProjects.isEmpty
                ? 'Open any book to continue.'
                : 'These books are still running or ready when you are.',
            projects: backgroundProjects,
            featureFirstCard: attentionProjects.isEmpty,
          ),
          const SizedBox(height: 18),
        ],
        _BillingSummarySlot(
          billing: billing,
          onAddCredits: onAddCredits,
          onRetry: onRetryBilling,
        ),
      ],
    );
  }
}

class _HomeHeader extends StatelessWidget {
  const _HomeHeader({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return AppSectionHeader(
      title: title,
      subtitle: subtitle,
      titleStyle: Theme.of(
        context,
      ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
    );
  }
}

class _FirstProjectCard extends StatelessWidget {
  const _FirstProjectCard({required this.onStartBook});

  final VoidCallback onStartBook;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final onGradient = colors.onPrimary;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            colors.primary,
            Color.lerp(colors.primary, colors.tertiary, 0.55)!,
          ],
        ),
        borderRadius: BorderRadius.circular(TomezaRadii.card),
        boxShadow: [
          BoxShadow(
            color: colors.primary.withValues(alpha: 0.3),
            blurRadius: 24,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: onGradient.withValues(alpha: 0.16),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Icon(Icons.auto_awesome_outlined, color: onGradient),
            ),
            const SizedBox(height: 14),
            Text(
              'Turn one idea into a book plan.',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                color: onGradient,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Describe your idea in a quick chat. The studio asks a few simple questions, builds a plan, and you review it before writing starts.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: onGradient.withValues(alpha: 0.9),
              ),
            ),
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: onStartBook,
              style: FilledButton.styleFrom(
                backgroundColor: onGradient,
                foregroundColor: colors.primary,
              ),
              icon: const Icon(Icons.add),
              label: const Text('Start your first book'),
            ),
          ],
        ),
      ),
    );
  }
}

class _SecondaryStartBookAction extends StatelessWidget {
  const _SecondaryStartBookAction({required this.onStartBook});

  final VoidCallback onStartBook;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(TomezaRadii.control),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
        child: Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 12,
          runSpacing: 10,
          children: [
            Text(
              'Have another idea?',
              style: Theme.of(
                context,
              ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
            OutlinedButton.icon(
              onPressed: onStartBook,
              icon: const Icon(Icons.add),
              label: const Text('Start another book'),
            ),
          ],
        ),
      ),
    );
  }
}

class _BillingSummarySlot extends StatelessWidget {
  const _BillingSummarySlot({
    required this.billing,
    required this.onAddCredits,
    required this.onRetry,
  });

  final AsyncValue<MobileBilling> billing;
  final VoidCallback onAddCredits;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return billing.when(
      data: (value) =>
          _BillingSummary(billing: value, onAddCredits: onAddCredits),
      loading: () => const AppInlineNotice(
        icon: Icons.account_balance_wallet_outlined,
        title: 'Checking book credits',
        message: 'Credits will appear here before any paid book action.',
      ),
      error: (error, stackTrace) => AppInlineNotice(
        icon: Icons.account_balance_wallet_outlined,
        title: 'Credit balance unavailable',
        message: userFacingError(error),
        actionLabel: 'Retry',
        onAction: onRetry,
      ),
    );
  }
}

class _BillingSummary extends StatelessWidget {
  const _BillingSummary({required this.billing, required this.onAddCredits});

  final MobileBilling billing;
  final VoidCallback onAddCredits;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final exportBooks = billing.activeExportUnlockCount;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.account_balance_wallet_outlined,
                  color: colors.onSurfaceVariant,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Book credits',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                Text(
                  '${billing.credits.available} available',
                  style: Theme.of(
                    context,
                  ).textTheme.labelLarge?.copyWith(color: colors.primary),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Used when you approve a full book or unlock finished exports.',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
            if (exportBooks > 0) ...[
              const SizedBox(height: 4),
              Text(
                exportBooks == 1
                    ? 'One book already includes export access.'
                    : '$exportBooks books already include export access.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: onAddCredits,
                icon: const Icon(Icons.add_card_outlined),
                label: const Text('Add credits'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProjectSection extends StatelessWidget {
  const _ProjectSection({
    required this.title,
    required this.subtitle,
    required this.projects,
    this.featureFirstCard = false,
  });

  final String title;
  final String subtitle;
  final List<MobileProjectSummary> projects;
  final bool featureFirstCard;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppSectionHeader(title: title, subtitle: subtitle),
        const SizedBox(height: 12),
        for (var index = 0; index < projects.length; index++) ...[
          ProjectCard(
            project: projects[index],
            featured: featureFirstCard && index == 0,
          ),
          if (index != projects.length - 1) const SizedBox(height: 12),
        ],
      ],
    );
  }
}

class ProjectCard extends StatelessWidget {
  const ProjectCard({required this.project, this.featured = false, super.key});

  final MobileProjectSummary project;
  final bool featured;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final action = ProjectHomeAction.forProject(project);
    final progress = (project.progressPercent / 100).clamp(0.0, 1.0);

    return Card(
      shape: featured
          ? RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(TomezaRadii.card),
              side: BorderSide(
                color: colors.primary.withValues(alpha: 0.4),
                width: 1.4,
              ),
            )
          : null,
      child: InkWell(
        borderRadius: BorderRadius.circular(TomezaRadii.card),
        onTap: () => context.push(action.pathFor(project)),
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: featured
                          ? colors.primaryContainer
                          : colors.secondaryContainer,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Icon(
                      action.icon,
                      color: featured
                          ? colors.onPrimaryContainer
                          : colors.onSecondaryContainer,
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
                        const SizedBox(height: 6),
                        AppStatusBadge(label: action.statusLabel),
                      ],
                    ),
                  ),
                ],
              ),
              if (action.showProgress) ...[
                const SizedBox(height: 14),
                Semantics(
                  label: '${project.title} progress',
                  value:
                      '${project.progressPercent.clamp(0, 100).toInt()} percent complete',
                  child: ExcludeSemantics(
                    child: LinearProgressIndicator(value: progress),
                  ),
                ),
              ],
              const SizedBox(height: 14),
              Text(
                action.nextAction,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 4),
              Text(
                action.detail,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              if (project.promptPreview.trim().isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(
                  project.promptPreview,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final label in projectMeta(project))
                    AppMetricChip(label: label),
                ],
              ),
              const SizedBox(height: 14),
              Align(
                alignment: Alignment.centerLeft,
                child: featured
                    ? FilledButton.icon(
                        onPressed: () => context.push(action.pathFor(project)),
                        icon: Icon(action.buttonIcon),
                        label: Text(action.buttonLabel),
                      )
                    : OutlinedButton.icon(
                        onPressed: () => context.push(action.pathFor(project)),
                        icon: Icon(action.buttonIcon),
                        label: Text(action.buttonLabel),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class ProjectHomeAction {
  const ProjectHomeAction({
    required this.priority,
    required this.statusLabel,
    required this.nextAction,
    required this.detail,
    required this.buttonLabel,
    required this.icon,
    required this.buttonIcon,
    this.needsUserAction = false,
    this.opensProgress = false,
    this.showProgress = false,
  });

  final int priority;
  final String statusLabel;
  final String nextAction;
  final String detail;
  final String buttonLabel;
  final IconData icon;
  final IconData buttonIcon;
  final bool needsUserAction;
  final bool opensProgress;
  final bool showProgress;

  String pathFor(MobileProjectSummary project) {
    final suffix = opensProgress ? '/handoff' : '';
    return '/projects/${project.id}$suffix';
  }

  static ProjectHomeAction forProject(MobileProjectSummary project) {
    final status = project.status.toLowerCase();

    if (status == 'failed') {
      return const ProjectHomeAction(
        priority: 0,
        statusLabel: 'Needs your attention',
        nextAction: 'Retry or review the issue',
        detail: 'Open progress to see what happened and resume if available.',
        buttonLabel: 'Fix issue',
        icon: Icons.error_outline,
        buttonIcon: Icons.replay_outlined,
        needsUserAction: true,
        opensProgress: true,
        showProgress: true,
      );
    }

    if (status == 'plan_ready') {
      return const ProjectHomeAction(
        priority: 1,
        statusLabel: 'Plan ready',
        nextAction: 'Review the plan',
        detail: 'Approve it, revise it, or answer follow-up questions.',
        buttonLabel: 'Review plan',
        icon: Icons.rate_review_outlined,
        buttonIcon: Icons.arrow_forward,
        needsUserAction: true,
        showProgress: true,
      );
    }

    if (status == 'complete' || project.hasReadyExport) {
      return const ProjectHomeAction(
        priority: 3,
        statusLabel: 'Exports ready',
        nextAction: 'Download or share',
        detail: 'Your finished files are ready to open from progress.',
        buttonLabel: 'Open exports',
        icon: Icons.download_done_outlined,
        buttonIcon: Icons.download_outlined,
        needsUserAction: true,
        opensProgress: true,
        showProgress: true,
      );
    }

    if (status == 'planning') {
      return const ProjectHomeAction(
        priority: 4,
        statusLabel: 'Plan in progress',
        nextAction: 'Wait for the plan',
        detail: 'Tomeza is preparing the plan for you to review next.',
        buttonLabel: 'Check plan',
        icon: Icons.pending_actions_outlined,
        buttonIcon: Icons.arrow_forward,
        showProgress: true,
      );
    }

    if (status == 'draft' || !project.hasPlan) {
      return const ProjectHomeAction(
        priority: 2,
        statusLabel: 'Ready for a plan',
        nextAction: 'Build the plan',
        detail: 'Turn the saved idea into a book plan before writing starts.',
        buttonLabel: 'Build the plan',
        icon: Icons.auto_awesome_outlined,
        buttonIcon: Icons.auto_awesome_outlined,
        needsUserAction: true,
      );
    }

    if (status == 'generating') {
      final preparingDownloads = project.progressPercent >= 90;
      return ProjectHomeAction(
        priority: 5,
        statusLabel: preparingDownloads
            ? 'Preparing downloads'
            : 'Writing in progress',
        nextAction: 'View progress',
        detail: preparingDownloads
            ? 'Your book is nearly ready for export.'
            : 'Pages and visuals are being created in the background.',
        buttonLabel: 'View progress',
        icon: Icons.hourglass_top_outlined,
        buttonIcon: Icons.arrow_forward,
        opensProgress: true,
        showProgress: true,
      );
    }

    return const ProjectHomeAction(
      priority: 6,
      statusLabel: 'In progress',
      nextAction: 'Open this book',
      detail: 'Continue from the latest saved step.',
      buttonLabel: 'Open book',
      icon: Icons.menu_book_outlined,
      buttonIcon: Icons.arrow_forward,
      showProgress: true,
    );
  }
}

List<MobileProjectSummary> sortProjectsByNextAction(
  List<MobileProjectSummary> projects,
) {
  final sorted = [...projects];
  sorted.sort((a, b) {
    final actionA = ProjectHomeAction.forProject(a);
    final actionB = ProjectHomeAction.forProject(b);
    final priority = actionA.priority.compareTo(actionB.priority);
    if (priority != 0) {
      return priority;
    }
    final updated = b.updatedAt.compareTo(a.updatedAt);
    if (updated != 0) {
      return updated;
    }
    return a.title.compareTo(b.title);
  });
  return sorted;
}

List<String> projectMeta(MobileProjectSummary project) {
  return [
    project.bookTypeLabel,
    project.lengthPresetLabel,
    if (project.imagesEnabled) 'Visuals included',
    if (project.hasReadyExport)
      'Exports ready'
    else if (project.pageCount > 0)
      '${project.pageCount}/${project.targetPages} pages',
  ];
}

String _firstName(String? displayName) {
  final value = displayName?.trim();
  if (value == null || value.isEmpty) {
    return 'there';
  }
  if (value.contains('@')) {
    return value.split('@').first;
  }
  return value.split(RegExp(r'\s+')).first;
}
