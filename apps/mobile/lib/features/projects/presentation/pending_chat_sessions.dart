import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/creation_repository.dart';

/// A new chat whose first send is still in flight, or that just finished but
/// is not yet present in the fetched session list.
@immutable
class PendingChatSession {
  const PendingChatSession({
    required this.localKey,
    required this.title,
    required this.startedAt,
    this.draftId,
  });

  /// The optimistic message localId of the send that created this chat.
  final String localKey;
  final String title;
  final DateTime startedAt;

  /// Set once the server has created the chat; null while in flight.
  final String? draftId;

  PendingChatSession copyWith({String? draftId}) {
    return PendingChatSession(
      localKey: localKey,
      title: title,
      startedAt: startedAt,
      draftId: draftId ?? this.draftId,
    );
  }
}

/// Registry of chats being created, shown in the history drawer so a new chat
/// is visible (and reachable again) even if the user switches chats or
/// navigates away while the first send is still running.
class PendingChatSessionsNotifier extends Notifier<List<PendingChatSession>> {
  @override
  List<PendingChatSession> build() {
    // Once the fetched list contains a resolved entry, the real tile takes
    // over and the pending one is dropped.
    ref.listen(chatSessionsProvider, (previous, next) {
      final sessions = next.value;
      if (sessions == null || state.isEmpty) {
        return;
      }
      final fetchedIds = {for (final session in sessions) session.draftId};
      final remaining = [
        for (final entry in state)
          if (entry.draftId == null || !fetchedIds.contains(entry.draftId))
            entry,
      ];
      if (remaining.length != state.length) {
        state = remaining;
      }
    });
    return const [];
  }

  void add(PendingChatSession entry) {
    state = [entry, ...state];
  }

  void resolve(String localKey, String draftId) {
    state = [
      for (final entry in state)
        if (entry.localKey == localKey)
          entry.copyWith(draftId: draftId)
        else
          entry,
    ];
  }

  void remove(String localKey) {
    state = [
      for (final entry in state)
        if (entry.localKey != localKey) entry,
    ];
  }
}

/// Deliberately not autoDispose: entries must outlive the chat screen and its
/// controller so an in-flight new chat survives any navigation.
final pendingChatSessionsProvider =
    NotifierProvider<PendingChatSessionsNotifier, List<PendingChatSession>>(
      PendingChatSessionsNotifier.new,
    );
