import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';

MobileChatSessionPage chatSessionPageFixture(
  List<MobileChatSession> sessions, {
  String? cursor,
  String query = '',
  int limit = 30,
}) {
  final matches = sessions
      .where(
        (session) =>
            session.title.toLowerCase().contains(query.toLowerCase()) ||
            session.preview.toLowerCase().contains(query.toLowerCase()),
      )
      .toList();
  final start = int.tryParse(cursor ?? '') ?? 0;
  final page = matches.skip(start).take(limit).toList();
  final end = start + page.length;
  return MobileChatSessionPage(
    sessions: page,
    nextCursor: end < matches.length ? '$end' : null,
  );
}

mixin ListSessionsPageFromList implements CreationRepository {
  @override
  Future<MobileChatSessionPage> listSessionsPage({
    String? cursor,
    String query = '',
  }) async => chatSessionPageFixture(
    await listSessions(),
    cursor: cursor,
    query: query,
  );
}
