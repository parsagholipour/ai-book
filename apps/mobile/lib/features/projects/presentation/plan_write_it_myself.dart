import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../studio/data/studio_repository.dart';
import '../../studio/presentation/studio_location.dart';
import '../data/projects_repository.dart';

/// The generated road's last fork, said quietly: keep the plan's outline and
/// write the book yourself in the Writing Studio.
///
/// It sits under Approve as a text link, never a second button — the casual
/// route stays one decision, and this is the door for the few who came to
/// write. It converts the plan (the server refuses a plan already approved)
/// and opens the Studio on the new outline.
class PlanWriteItMyselfLink extends ConsumerStatefulWidget {
  const PlanWriteItMyselfLink({
    required this.projectId,
    this.enabled = true,
    super.key,
  });

  final String projectId;

  /// False while the page is busy with the plan (approving, revising).
  final bool enabled;

  @override
  ConsumerState<PlanWriteItMyselfLink> createState() =>
      _PlanWriteItMyselfLinkState();
}

class _PlanWriteItMyselfLinkState extends ConsumerState<PlanWriteItMyselfLink> {
  bool _busy = false;

  /// Kept across a retry after a network failure, so a conversion that did
  /// land is replayed rather than refused as already done.
  String? _requestId;

  Future<void> _convert() async {
    final confirmed = await showAppConfirmationDialog(
      context,
      title: 'Write it yourself?',
      message:
          'Keep this outline and write the book yourself in the Writing '
          'Studio. The AI won\'t write it — you can still use AI tools while '
          'you write.',
      confirmLabel: 'Write it myself',
      icon: Icons.edit_outlined,
    );
    if (!confirmed || !mounted) return;
    final id = widget.projectId;
    final container = ProviderScope.containerOf(context, listen: false);
    final router = GoRouter.of(context);
    final messenger = ScaffoldMessenger.maybeOf(context);
    _requestId ??= studioRequestId('studio-from-plan');
    AppHaptics.commit();
    setState(() => _busy = true);
    try {
      await container
          .read(studioRepositoryProvider)
          .convertPlanToManuscript(id, requestId: _requestId!);
      _requestId = null;
      container
        ..invalidate(projectsProvider)
        ..invalidate(projectDetailProvider(id))
        ..invalidate(projectStatusProvider(id))
        ..invalidate(manuscriptProvider(id));
      AppHaptics.success();
      router.go(studioLocation(id));
    } on ApiException catch (error) {
      // The server answered and did nothing; the next tap is a new request.
      _requestId = null;
      if (error.code == 'PLAN_NOT_CONVERTIBLE') {
        // Something moved under the page (an approval on another device):
        // show the book as it is now.
        container.invalidate(projectDetailProvider(id));
      }
      AppHaptics.error();
      messenger?.showAppSnackBar(
        SnackBar(content: Text(userFacingError(error))),
      );
    } catch (error) {
      AppHaptics.error();
      messenger?.showAppSnackBar(
        SnackBar(content: Text(userFacingError(error))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: AppButton.text(
        key: const ValueKey('plan-write-it-myself'),
        label: 'I\'ll write it myself',
        loading: _busy,
        loadingLabel: 'Opening the Writing Studio',
        onPressed: widget.enabled && !_busy ? _convert : null,
      ),
    );
  }
}
