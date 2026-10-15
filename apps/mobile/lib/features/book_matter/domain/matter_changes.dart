/// Collects one partial update, field by field: only what changed is kept,
/// text is compared trimmed, and a field that had text and is now empty
/// becomes a clear.
///
/// Sending only the changes is what lets two devices edit different fields
/// without undoing each other — the same rule the Studio's book settings
/// follow.
class MatterChanges {
  final Set<String> _cleared = {};

  /// Wire names of the fields the author emptied, sent as null.
  Set<String> get cleared => Set.unmodifiable(_cleared);

  /// The new text for [field], or null when it is unchanged or was emptied
  /// (an emptied field lands in [cleared] instead).
  String? text(String field, String? before, String after) {
    final was = before?.trim() ?? '';
    final now = after.trim();
    if (was == now) return null;
    if (now.isEmpty) {
      _cleared.add(field);
      return null;
    }
    return now;
  }

  /// The new value of a switch, or null when it did not move.
  bool? flag(bool before, bool after) => before == after ? null : after;
}
