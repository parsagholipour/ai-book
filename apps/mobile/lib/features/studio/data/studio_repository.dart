import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../domain/assist_models.dart';
import '../domain/manuscript_models.dart';

/// The Writing Studio's server surface — `/api/mobile/projects/:id/manuscript`
/// and `POST /api/mobile/projects/studio`. See `.scratch/writing-studio/spec.md`.
abstract interface class StudioRepository {
  Future<StudioBookCreated> createBook({
    required ManuscriptKind kind,
    required String requestId,
    String? title,
    String? language,
  });

  Future<Manuscript> getManuscript(String projectId);

  Future<ManuscriptChapter> getChapter(String projectId, String chapterId);

  /// Saves one chapter. Throws [ManuscriptChapterConflictException] when
  /// another device saved a newer revision first.
  Future<ManuscriptChapterSaveResult> saveChapter({
    required String projectId,
    required String chapterId,
    required String title,
    required String markdown,
    required int baseRevision,
    String? notes,
    ManuscriptChapterStatus? status,
    ManuscriptSaveCheckpoint? checkpoint,
    ManuscriptConflictResolution? resolveConflict,
  });

  Future<({ManuscriptChapter chapter, Manuscript manuscript})> addChapter({
    required String projectId,
    required String requestId,
    String? afterChapterId,
    String? title,
  });

  Future<Manuscript> deleteChapter(String projectId, String chapterId);

  Future<Manuscript> restoreChapter(String projectId, String chapterId);

  Future<Manuscript> reorderChapters(String projectId, List<String> chapterIds);

  Future<Manuscript> updateSettings(
    String projectId,
    ManuscriptSettingsUpdate update,
  );

  Future<List<ManuscriptVersionSummary>> listVersions(
    String projectId,
    String chapterId,
  );

  Future<ManuscriptVersion> getVersion(
    String projectId,
    String chapterId,
    String versionId,
  );

  Future<ManuscriptUploadedImage> uploadImage({
    required String projectId,
    required List<int> bytes,
    required String filename,
    required String contentType,
    void Function(int sent, int total)? onProgress,
  });

  /// What publishing would do, without doing it.
  Future<PublishChecklist> publishChecklist(
    String projectId, {
    required String requestId,
  });

  Future<Manuscript> publish(String projectId, {required String requestId});

  /// Rewrite, proofread, continue, describe, brainstorm or ask — answered
  /// inline. Spends one chat message from the author's allowance.
  Future<QuickAssistResult> runQuickAssist(
    String projectId,
    QuickAssistRequest request,
  );

  /// Starts a background tool (illustration, chapter draft, feedback,
  /// consistency check, outline). Priced in credits; the result lands later.
  Future<ManuscriptAssist> startAssist(
    String projectId,
    LongAssistRequest request,
  );

  /// Background tools still working or waiting to be looked at.
  Future<List<ManuscriptAssist>> listOpenAssists(
    String projectId, {
    String? chapterId,
  });

  Future<ManuscriptAssist> getAssist(String projectId, String assistId);

  Future<ManuscriptAssist> dismissAssist(String projectId, String assistId);

  /// Records that the author used the result.
  Future<ManuscriptAssist> markAssistApplied(String projectId, String assistId);

  Future<Manuscript> uploadCover({
    required String projectId,
    required List<int> bytes,
    required String filename,
    required String contentType,
    void Function(int sent, int total)? onProgress,
  });

  /// An AI-drawn cover, priced in credits.
  Future<Manuscript> generateCover(
    String projectId, {
    required String requestId,
  });

  /// Back to a designed cover (free).
  Future<Manuscript> useDesignedCover(String projectId);

  /// Turns a generated book's not-yet-approved plan into a Studio outline the
  /// author writes themselves. Returns the book's (unchanged) id.
  Future<Manuscript> convertPlanToManuscript(
    String projectId, {
    required String requestId,
  });

  /// Moves a finished AI-generated book into the Writing Studio as its
  /// owner's own manuscript: free and one-way. Idempotent by [requestId], and a
  /// book that is already the author's answers its manuscript as it stands.
  Future<Manuscript> takeOverBook(
    String projectId, {
    required String requestId,
  });
}

/// Forces a version of the text *before* this save to be kept.
enum ManuscriptSaveCheckpoint {
  beforeAi('before_ai'),
  restore('restore');

  const ManuscriptSaveCheckpoint(this.wire);

  final String wire;
}

/// How a chapter conflict is settled: keep the Studio's text, or take the
/// book's version.
enum ManuscriptConflictResolution {
  mine('mine'),
  book('book');

  const ManuscriptConflictResolution(this.wire);

  final String wire;
}

/// A partial settings change. Only the fields set here are sent; a name in
/// [clear] is sent as null, which removes that value on the server.
class ManuscriptSettingsUpdate {
  const ManuscriptSettingsUpdate({
    this.title,
    this.subtitle,
    this.authorName,
    this.dedication,
    this.artStyle,
    this.goalWords,
    this.layout,
    this.castCharacterIds,
    this.clear = const {},
  });

  final String? title;
  final String? subtitle;
  final String? authorName;
  final String? dedication;
  final String? artStyle;
  final int? goalWords;
  final ManuscriptLayout? layout;

  /// The whole cast, replacing the previous one.
  final List<String>? castCharacterIds;

  /// Any of 'subtitle', 'authorName', 'dedication', 'artStyle', 'goalWords'.
  final Set<String> clear;

  Map<String, Object?> toJson() => {
    'title': ?title,
    'subtitle': ?subtitle,
    'authorName': ?authorName,
    'dedication': ?dedication,
    'artStyle': ?artStyle,
    'goalWords': ?goalWords,
    'layout': ?layout?.wire,
    'castCharacterIds': ?castCharacterIds,
    for (final field in clear) field: null,
  };
}

class MobileStudioRepository implements StudioRepository {
  MobileStudioRepository({required this.apiClient});

  final ApiClient apiClient;

  String _base(String projectId) =>
      '/api/mobile/projects/$projectId/manuscript';

  @override
  Future<StudioBookCreated> createBook({
    required ManuscriptKind kind,
    required String requestId,
    String? title,
    String? language,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/studio',
      data: {
        'kind': kind.wire,
        'requestId': requestId,
        if (title != null && title.trim().isNotEmpty) 'title': title.trim(),
        'language': ?language,
      },
    );
    final manuscript = Manuscript.fromJson(
      data['manuscript'] as Map<String, dynamic>,
    );
    return StudioBookCreated(
      projectId: manuscript.projectId,
      manuscript: manuscript,
      chapter: ManuscriptChapter.fromJson(
        data['chapter'] as Map<String, dynamic>,
      ),
    );
  }

  @override
  Future<Manuscript> getManuscript(String projectId) async {
    final data = await apiClient.getMap(_base(projectId));
    return Manuscript.fromJson(data['manuscript'] as Map<String, dynamic>);
  }

  @override
  Future<ManuscriptChapter> getChapter(
    String projectId,
    String chapterId,
  ) async {
    final data = await apiClient.getMap(
      '${_base(projectId)}/chapters/$chapterId',
    );
    return ManuscriptChapter.fromJson(data['chapter'] as Map<String, dynamic>);
  }

  @override
  Future<ManuscriptChapterSaveResult> saveChapter({
    required String projectId,
    required String chapterId,
    required String title,
    required String markdown,
    required int baseRevision,
    String? notes,
    ManuscriptChapterStatus? status,
    ManuscriptSaveCheckpoint? checkpoint,
    ManuscriptConflictResolution? resolveConflict,
  }) async {
    try {
      final response = await apiClient.putJson(
        '${_base(projectId)}/chapters/$chapterId',
        data: {
          'title': title,
          'markdown': markdown,
          'baseRevision': baseRevision,
          'notes': ?notes,
          'status': ?status?.wire,
          'checkpoint': ?checkpoint?.wire,
          'resolveConflict': ?resolveConflict?.wire,
        },
      );
      return ManuscriptChapterSaveResult.fromJson(
        response.data as Map<String, dynamic>,
      );
    } on ApiException catch (error) {
      final serverChapter = error.details['chapter'];
      if (error.code == 'CHAPTER_CONFLICT' &&
          serverChapter is Map<String, dynamic>) {
        throw ManuscriptChapterConflictException(
          ManuscriptChapter.fromJson(serverChapter),
        );
      }
      rethrow;
    }
  }

  @override
  Future<({ManuscriptChapter chapter, Manuscript manuscript})> addChapter({
    required String projectId,
    required String requestId,
    String? afterChapterId,
    String? title,
  }) async {
    final data = await apiClient.postMap(
      '${_base(projectId)}/chapters',
      data: {
        'requestId': requestId,
        'afterChapterId': afterChapterId,
        'title': ?title,
      },
    );
    return (
      chapter: ManuscriptChapter.fromJson(
        data['chapter'] as Map<String, dynamic>,
      ),
      manuscript: Manuscript.fromJson(
        data['manuscript'] as Map<String, dynamic>,
      ),
    );
  }

  @override
  Future<Manuscript> deleteChapter(String projectId, String chapterId) async {
    final response = await apiClient.deleteJson(
      '${_base(projectId)}/chapters/$chapterId',
    );
    return _manuscriptFrom(response.data);
  }

  @override
  Future<Manuscript> restoreChapter(String projectId, String chapterId) async {
    final data = await apiClient.postMap(
      '${_base(projectId)}/chapters/$chapterId/restore',
    );
    return _manuscriptFrom(data);
  }

  @override
  Future<Manuscript> reorderChapters(
    String projectId,
    List<String> chapterIds,
  ) async {
    final data = await apiClient.postMap(
      '${_base(projectId)}/order',
      data: {'chapterIds': chapterIds},
    );
    return _manuscriptFrom(data);
  }

  @override
  Future<Manuscript> updateSettings(
    String projectId,
    ManuscriptSettingsUpdate update,
  ) async {
    final response = await apiClient.patchJson(
      '${_base(projectId)}/settings',
      data: update.toJson(),
    );
    return _manuscriptFrom(response.data);
  }

  @override
  Future<List<ManuscriptVersionSummary>> listVersions(
    String projectId,
    String chapterId,
  ) async {
    final data = await apiClient.getMap(
      '${_base(projectId)}/chapters/$chapterId/versions',
    );
    return (data['versions'] as List<dynamic>? ?? const [])
        .map(
          (item) =>
              ManuscriptVersionSummary.fromJson(item as Map<String, dynamic>),
        )
        .toList(growable: false);
  }

  @override
  Future<ManuscriptVersion> getVersion(
    String projectId,
    String chapterId,
    String versionId,
  ) async {
    final data = await apiClient.getMap(
      '${_base(projectId)}/chapters/$chapterId/versions/$versionId',
    );
    return ManuscriptVersion.fromJson(data['version'] as Map<String, dynamic>);
  }

  @override
  Future<ManuscriptUploadedImage> uploadImage({
    required String projectId,
    required List<int> bytes,
    required String filename,
    required String contentType,
    void Function(int sent, int total)? onProgress,
  }) async {
    final response = await apiClient.putBytes(
      '${_base(projectId)}/images',
      bytes: bytes,
      queryParameters: {'filename': filename, 'contentType': contentType},
      onSendProgress: onProgress,
    );
    return ManuscriptUploadedImage.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<PublishChecklist> publishChecklist(
    String projectId, {
    required String requestId,
  }) async {
    final data = await apiClient.postMap(
      '${_base(projectId)}/publish',
      data: {'requestId': requestId, 'dryRun': true},
    );
    return PublishChecklist.fromJson(data['checklist'] as Map<String, dynamic>);
  }

  @override
  Future<Manuscript> publish(
    String projectId, {
    required String requestId,
  }) async {
    Future<Map<String, dynamic>> attempt() => apiClient.postMap(
      '${_base(projectId)}/publish',
      data: {'requestId': requestId},
      // A long book is written in one transaction; the default 20 s would
      // report a healthy publish as a network error.
      receiveTimeout: const Duration(seconds: 150),
    );
    try {
      return _manuscriptFrom(await attempt());
    } on ApiException catch (error) {
      // Two writers locking the same rows in opposite orders; the server
      // asks for exactly one retry.
      if (error.code != 'PUBLISH_RETRY') rethrow;
      return _manuscriptFrom(await attempt());
    }
  }

  @override
  Future<QuickAssistResult> runQuickAssist(
    String projectId,
    QuickAssistRequest request,
  ) async {
    final data = await apiClient.postMap(
      '${_base(projectId)}/assist',
      data: request.toJson(),
      // The server time-boxes the model at 40 s; leave room for the network.
      receiveTimeout: const Duration(seconds: 60),
    );
    return QuickAssistResult.fromJson(data['assist'] as Map<String, dynamic>);
  }

  @override
  Future<ManuscriptAssist> startAssist(
    String projectId,
    LongAssistRequest request,
  ) async {
    final data = await apiClient.postMap(
      '${_base(projectId)}/assists',
      data: request.toJson(),
    );
    return _assistFrom(data);
  }

  @override
  Future<List<ManuscriptAssist>> listOpenAssists(
    String projectId, {
    String? chapterId,
  }) async {
    final query = chapterId == null ? '' : '&chapterId=$chapterId';
    final data = await apiClient.getMap(
      '${_base(projectId)}/assists?open=1$query',
    );
    return (data['assists'] as List<dynamic>? ?? const [])
        .map((item) => ManuscriptAssist.fromJson(item as Map<String, dynamic>))
        .toList(growable: false);
  }

  @override
  Future<ManuscriptAssist> getAssist(String projectId, String assistId) async {
    return _assistFrom(
      await apiClient.getMap('${_base(projectId)}/assists/$assistId'),
    );
  }

  @override
  Future<ManuscriptAssist> dismissAssist(
    String projectId,
    String assistId,
  ) async {
    return _assistFrom(
      await apiClient.postMap('${_base(projectId)}/assists/$assistId/dismiss'),
    );
  }

  @override
  Future<ManuscriptAssist> markAssistApplied(
    String projectId,
    String assistId,
  ) async {
    return _assistFrom(
      await apiClient.postMap('${_base(projectId)}/assists/$assistId/applied'),
    );
  }

  @override
  Future<Manuscript> uploadCover({
    required String projectId,
    required List<int> bytes,
    required String filename,
    required String contentType,
    void Function(int sent, int total)? onProgress,
  }) async {
    final response = await apiClient.putBytes(
      '${_base(projectId)}/cover',
      bytes: bytes,
      queryParameters: {'filename': filename, 'contentType': contentType},
      onSendProgress: onProgress,
    );
    return _manuscriptFrom(response.data);
  }

  @override
  Future<Manuscript> generateCover(
    String projectId, {
    required String requestId,
  }) async {
    return _manuscriptFrom(
      await apiClient.postMap(
        '${_base(projectId)}/cover/generate',
        data: {'requestId': requestId},
      ),
    );
  }

  @override
  Future<Manuscript> useDesignedCover(String projectId) async {
    final response = await apiClient.deleteJson('${_base(projectId)}/cover');
    return _manuscriptFrom(response.data);
  }

  @override
  Future<Manuscript> convertPlanToManuscript(
    String projectId, {
    required String requestId,
  }) async {
    return _manuscriptFrom(
      await apiClient.postMap(
        '${_base(projectId)}/from-plan',
        data: {'requestId': requestId},
      ),
    );
  }

  @override
  Future<Manuscript> takeOverBook(
    String projectId, {
    required String requestId,
  }) async {
    return _manuscriptFrom(
      await apiClient.postMap(
        '${_base(projectId)}/takeover',
        data: {'requestId': requestId},
      ),
    );
  }

  ManuscriptAssist _assistFrom(Map<String, dynamic> data) {
    return ManuscriptAssist.fromJson(data['assist'] as Map<String, dynamic>);
  }

  Manuscript _manuscriptFrom(Object? data) {
    final map = data as Map<String, dynamic>;
    return Manuscript.fromJson(map['manuscript'] as Map<String, dynamic>);
  }
}

final studioRepositoryProvider = Provider<StudioRepository>((ref) {
  return MobileStudioRepository(apiClient: ref.watch(apiClientProvider));
});

/// The working copy's metadata and outline for one book.
final manuscriptProvider = FutureProvider.autoDispose
    .family<Manuscript, String>((ref, projectId) {
      return ref.watch(studioRepositoryProvider).getManuscript(projectId);
    });

/// Identifies one chapter of one book.
typedef ManuscriptChapterRef = ({String projectId, String chapterId});

final manuscriptVersionsProvider = FutureProvider.autoDispose
    .family<List<ManuscriptVersionSummary>, ManuscriptChapterRef>((
      ref,
      target,
    ) {
      return ref
          .watch(studioRepositoryProvider)
          .listVersions(target.projectId, target.chapterId);
    });
