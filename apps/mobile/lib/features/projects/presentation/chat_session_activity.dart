import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/projects_repository.dart';
import '../domain/project_models.dart';

/// Whether the book a chat is currently working on is still being planned,
/// written or edited — what the history drawer draws a spinner for instead of
/// the chat glyph.
///
/// The cached project list answers for free, and answers correctly the moment
/// the drawer opens, because the shelf refreshes it there. It goes stale while
/// the drawer stays open though, and a book that is still only being *planned*
/// has no shelf card following it — the shelf takes books with pages — so a
/// project the list still calls live is followed on its own status stream as
/// well, and the stream's verdict wins.
///
/// That stream ends by itself when the book settles, so this keeps watching the
/// settled value rather than dropping the subscription: releasing it the moment
/// it says "settled" would hand the answer straight back to the stale list,
/// which would resubscribe and flap. The list catching up is what ends the
/// watch, and until then a settled stream costs nothing.
final chatBookBusyProvider = Provider.autoDispose.family<bool, String?>((
  ref,
  projectId,
) {
  if (projectId == null) return false;
  final projects = ref.watch(projectsProvider).value;
  if (projects == null) return false;
  final summary = _summaryFor(projects, projectId);
  if (summary == null || !summary.isLive) return false;
  return ref.watch(projectStatusProvider(projectId)).value?.isLive ?? true;
});

MobileProjectSummary? _summaryFor(
  List<MobileProjectSummary> projects,
  String id,
) {
  for (final project in projects) {
    if (project.id == id) return project;
  }
  return null;
}
