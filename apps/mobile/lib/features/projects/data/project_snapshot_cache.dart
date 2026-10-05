import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/project_models.dart';

/// Last successful reads for a chat's output. The request providers still
/// auto-dispose (including live connections) and refresh on return; these
/// snapshots keep navigation from briefly erasing the book's known state.
class ProjectSnapshotCache {
  final details = <String, MobileProjectDetail>{};
  final chats = <String, MobileProjectChat>{};
  final statuses = <String, MobileProjectStatus>{};
}

/// Owned by the signed-in session and cleared on logout.
final projectSnapshotCacheProvider = Provider((ref) => ProjectSnapshotCache());
