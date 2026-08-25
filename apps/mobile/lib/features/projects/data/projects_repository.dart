import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/api/export_provenance.dart';
import '../domain/project_models.dart';
import 'export_repair_watch.dart';

enum ExportOpenOutcome { opened, sharedFallback }

abstract interface class ProjectsRepository {
  Future<List<MobileProjectSummary>> listProjects();

  Future<MobileProjectDetail> createProject(MobileProjectCreateRequest request);

  Future<MobileProjectDetail> getProject(String id);

  Future<MobilePlanOperation> generatePlan(String projectId);

  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
    String? requestId,
  });

  Future<MobilePlanOperation> approvePlan(
    String planId, {
    String? requestId,
    bool disableIllustrations = false,
  });

  Future<MobileProjectStatus> getProjectStatus(String id);

  Stream<MobileProjectStatus> watchProjectStatus(String id);

  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  });

  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
    String? requestId,
    String? replyToMessageId,
    List<String>? mentionedCharacterIds,
    Map<String, Object>? readerContext,
  });

  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
    List<String>? mentionedCharacterIds,
  });

  Future<MobileProjectChatSendResult> applyEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  });

  Future<MobileProjectChatSendResult> cancelEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  });

  Future<MobileProjectChatSendResult> undoLastBookEdit({
    required String projectId,
    String? requestId,
  });

  Future<MobileProjectChat> switchProjectChatBranch({
    required String projectId,
    required String messageId,
    required String direction,
  });

  Future<MobileEditableBook> getEditableBook(String projectId);

  Future<MobileEditChanges> getEditChanges({
    required String projectId,
    required String operationId,
  });

  Future<MobileManualBookEditResult> saveManualBookEdit({
    required String projectId,
    required List<MobileManualBookPageEdit> pages,
    String? savedExportMessageId,
    String? requestId,
  });

  Future<MobileProjectRecovery> resumeProject(
    String id, {
    String? requestId,
    String? retryToken,
  });

  Future<MobileBookEditOperation> retryOperation({
    required String projectId,
    required String operationId,
    String? requestId,
    String? retryToken,
  });

  Future<ProjectDeletionReceipt> deleteProject(String id);

  Future<ModerationReportReceipt> reportProject({
    required String projectId,
    required String reason,
    String? comment,
  });

  Future<ModerationReportReceipt> reportAsset({
    required String projectId,
    required String assetId,
    required String reason,
    String? comment,
  });

  /// Uploads an author's finished manuscript and creates an imported project.
  Future<MobileImportedBook> importBook({
    required List<int> bytes,
    required String filename,
    required String requestId,
    String? mimeType,
    String? title,
    String? language,
    void Function(int sent, int total)? onProgress,
  });

  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  });

  Future<ExportOpenOutcome> openExport({
    required String projectId,
    required MobileExportAvailability export,
  });

  Future<Map<String, String>> assetHeaders();
}

class MobileProjectsRepository implements ProjectsRepository {
  MobileProjectsRepository({
    required this.apiClient,
    Future<Directory> Function()? documentsDirectory,
  }) : _documentsDirectory =
           documentsDirectory ?? getApplicationDocumentsDirectory;

  final ApiClient apiClient;
  final Future<Directory> Function() _documentsDirectory;

  @override
  Future<List<MobileProjectSummary>> listProjects() async {
    final data = await apiClient.getMap('/api/mobile/projects');
    final projects = data['projects'] as List<dynamic>;
    return projects
        .map(
          (project) =>
              MobileProjectSummary.fromJson(project as Map<String, dynamic>),
        )
        .toList();
  }

  @override
  Future<MobileProjectDetail> createProject(
    MobileProjectCreateRequest request,
  ) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects',
      data: request.toJson(),
    );
    return MobileProjectDetail.fromJson(
      data['project'] as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileProjectDetail> getProject(String id) async {
    final data = await apiClient.getMap('/api/mobile/projects/$id');
    return MobileProjectDetail.fromJson(
      data['project'] as Map<String, dynamic>,
    );
  }

  @override
  Future<MobilePlanOperation> generatePlan(String projectId) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/plan',
      data: const <String, dynamic>{},
    );
    return MobilePlanOperation.fromJson(data);
  }

  @override
  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
    String? requestId,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/plans/$planId/revise',
      data: {'message': message, 'requestId': ?requestId},
    );
    return MobilePlanOperation.fromJson(data);
  }

  @override
  Future<MobilePlanOperation> approvePlan(
    String planId, {
    String? requestId,
    bool disableIllustrations = false,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/plans/$planId/approve',
      data: {
        'requestId': ?requestId,
        if (disableIllustrations) 'disableIllustrations': true,
      },
    );
    return MobilePlanOperation.fromJson(data);
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    final data = await apiClient.getMap('/api/mobile/projects/$id/status');
    return MobileProjectStatus.fromJson(data['status'] as Map<String, dynamic>);
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    await for (final event in apiClient.getServerSentEvents(
      '/api/mobile/projects/$id/status/events',
    )) {
      if (event.event != 'status') {
        continue;
      }
      final decoded = jsonDecode(event.data) as Map<String, dynamic>;
      final status = decoded['status'] is Map<String, dynamic>
          ? decoded['status'] as Map<String, dynamic>
          : decoded;
      yield MobileProjectStatus.fromJson(status);
    }
  }

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    final query = <String, String>{
      'limit': '$limit',
      'beforeMessageId': ?beforeMessageId,
    };
    final path = Uri(
      path: '/api/mobile/projects/$id/chat',
      queryParameters: query,
    ).toString();
    final data = await apiClient.getMap(path);
    return MobileProjectChat.fromJson(data);
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
    String? requestId,
    String? replyToMessageId,
    List<String>? mentionedCharacterIds,
    Map<String, Object>? readerContext,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/chat/messages',
      data: {
        'message': message,
        'requestId': ?requestId,
        'replyToMessageId': ?replyToMessageId,
        if (mentionedCharacterIds != null && mentionedCharacterIds.isNotEmpty)
          'mentionedCharacterIds': mentionedCharacterIds,
        if (readerContext != null && readerContext.isNotEmpty)
          'readerContext': readerContext,
      },
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileProjectChatSendResult.fromJson(data);
  }

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
    List<String>? mentionedCharacterIds,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/chat/messages',
      data: {
        'message': message,
        'editMessageId': messageId,
        'requestId': ?requestId,
        if (mentionedCharacterIds != null && mentionedCharacterIds.isNotEmpty)
          'mentionedCharacterIds': mentionedCharacterIds,
      },
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileProjectChatSendResult.fromJson(data);
  }

  @override
  Future<MobileProjectChatSendResult> applyEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/chat/proposals/apply',
      data: {'proposalId': proposalId, 'requestId': ?requestId},
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileProjectChatSendResult.fromJson(data);
  }

  @override
  Future<MobileProjectChatSendResult> cancelEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/chat/proposals/cancel',
      data: {'proposalId': proposalId, 'requestId': ?requestId},
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileProjectChatSendResult.fromJson(data);
  }

  @override
  Future<MobileProjectChatSendResult> undoLastBookEdit({
    required String projectId,
    String? requestId,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/chat/edits/undo',
      data: {'requestId': ?requestId},
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileProjectChatSendResult.fromJson(data);
  }

  @override
  Future<MobileProjectChat> switchProjectChatBranch({
    required String projectId,
    required String messageId,
    required String direction,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/chat/branches',
      data: {'messageId': messageId, 'direction': direction},
    );
    return MobileProjectChat.fromJson(data);
  }

  @override
  Future<MobileEditableBook> getEditableBook(String projectId) async {
    final data = await apiClient.getMap('/api/mobile/projects/$projectId/book');
    return MobileEditableBook.fromJson(data['book'] as Map<String, dynamic>);
  }

  @override
  Future<MobileEditChanges> getEditChanges({
    required String projectId,
    required String operationId,
  }) async {
    final data = await apiClient.getMap(
      '/api/mobile/projects/$projectId/operations/$operationId/changes',
    );
    return MobileEditChanges.fromJson(data['changes'] as Map<String, dynamic>);
  }

  @override
  Future<MobileManualBookEditResult> saveManualBookEdit({
    required String projectId,
    required List<MobileManualBookPageEdit> pages,
    String? savedExportMessageId,
    String? requestId,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/manual-edits',
      data: {
        'pages': pages.map((page) => page.toJson()).toList(),
        'savedExportMessageId': ?savedExportMessageId,
        'requestId': ?requestId,
      },
    );
    return MobileManualBookEditResult.fromJson(data);
  }

  @override
  Future<MobileProjectRecovery> resumeProject(
    String id, {
    String? requestId,
    String? retryToken,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$id/resume',
      data: {'requestId': ?requestId, 'retryToken': ?retryToken},
    );
    return MobileProjectRecovery.fromJson(data);
  }

  @override
  Future<MobileBookEditOperation> retryOperation({
    required String projectId,
    required String operationId,
    String? requestId,
    String? retryToken,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/operations/$operationId/retry',
      data: {'requestId': ?requestId, 'retryToken': ?retryToken},
    );
    final operation = data['operation'];
    return MobileBookEditOperation.fromJson(
      operation is Map<String, dynamic> ? operation : data,
    );
  }

  @override
  Future<ProjectDeletionReceipt> deleteProject(String id) async {
    final response = await apiClient.deleteJson('/api/mobile/projects/$id');
    return ProjectDeletionReceipt.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<ModerationReportReceipt> reportProject({
    required String projectId,
    required String reason,
    String? comment,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/reports',
      data: _reportPayload(reason: reason, comment: comment),
    );
    return ModerationReportReceipt.fromJson(
      data['report'] as Map<String, dynamic>,
    );
  }

  @override
  Future<ModerationReportReceipt> reportAsset({
    required String projectId,
    required String assetId,
    required String reason,
    String? comment,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/assets/$assetId/reports',
      data: _reportPayload(reason: reason, comment: comment),
    );
    return ModerationReportReceipt.fromJson(
      data['report'] as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileImportedBook> importBook({
    required List<int> bytes,
    required String filename,
    required String requestId,
    String? mimeType,
    String? title,
    String? language,
    void Function(int sent, int total)? onProgress,
  }) async {
    final response = await apiClient.postBytes(
      '/api/mobile/projects/import',
      bytes: bytes,
      queryParameters: {
        'filename': filename,
        'requestId': requestId,
        if (mimeType != null && mimeType.isNotEmpty) 'mimeType': mimeType,
        if (title != null && title.trim().isNotEmpty) 'title': title.trim(),
        if (language != null && language.trim().isNotEmpty)
          'language': language.trim(),
      },
      onSendProgress: onProgress,
    );
    return MobileImportedBook.fromJson(response.data as Map<String, dynamic>);
  }

  @override
  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    final directory = await _documentsDirectory();
    final safeProjectId = projectId.replaceAll(
      RegExp(r'[^A-Za-z0-9._-]+'),
      '-',
    );
    final exportDirectory = Directory(
      '${directory.path}/tomeza_exports/$safeProjectId',
    );
    if (!await exportDirectory.exists()) {
      await exportDirectory.create(recursive: true);
    }
    final filename = _safeLocalFilename(export.filename, export.format);
    final path = '${exportDirectory.path}/$filename';
    final partial = File('$path.part');
    if (await partial.exists()) {
      await partial.delete();
    }
    try {
      final received = await apiClient.downloadFile(
        export.downloadUrl,
        partial.path,
      );
      final byteSize = await partial.length();
      _validateDirectExportDownload(
        export: export,
        received: received,
        byteSize: byteSize,
      );
      final existing = File(path);
      if (await existing.exists()) {
        await existing.delete();
      }
      await partial.rename(path);
    } catch (_) {
      if (await partial.exists()) {
        await partial.delete();
      }
      rethrow;
    }
    return ProjectExportFile(
      format: export.format,
      filename: filename,
      path: path,
    );
  }

  @override
  Future<ExportOpenOutcome> openExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    final file = await downloadExport(projectId: projectId, export: export);
    final result = await OpenFilex.open(
      file.path,
      type: export.contentType,
      uti: export.format == 'pdf' ? 'com.adobe.pdf' : 'org.idpf.epub-container',
    );
    if (result.type == ResultType.done) {
      return ExportOpenOutcome.opened;
    }
    await SharePlus.instance.share(
      ShareParams(
        title: file.filename,
        subject: file.filename,
        files: [XFile(file.path, mimeType: export.contentType)],
        fileNameOverrides: [file.filename],
      ),
    );
    return ExportOpenOutcome.sharedFallback;
  }

  @override
  Future<Map<String, String>> assetHeaders() {
    return apiClient.authHeaders();
  }
}

/// Refuses bytes the response positively ties to an *older* compile.
///
/// What the bytes are is decided by [ExportProvenance.resolveDownload], the
/// same rule the reader's cache reads through. This surface is stricter about
/// what it keeps: silently handing an edited book's previous EPUB to the share
/// sheet is worse than asking for a retry, so a stale or unidentifiable
/// download throws. A *newer* exact revision is accepted — the retry after an
/// `EXPORT_NOT_READY` is routinely answered by the compile that just
/// published, and nothing newer is on offer. Refused bytes remain in the
/// temporary file and are removed by [downloadExport].
void _validateDirectExportDownload({
  required MobileExportAvailability export,
  required DownloadedFile received,
  required int byteSize,
}) {
  final resolved = ExportProvenance.fromDownload(received).resolveDownload(
    byteSize: byteSize,
    declaredContentLength: received.contentLength,
    descriptorRevision: export.revision,
    descriptorByteSize: export.byteSize,
  );
  switch (resolved.resolution) {
    case ExportDownloadResolution.identified:
      return;
    case ExportDownloadResolution.incomplete:
      throw const ApiException(
        code: 'EXPORT_DOWNLOAD_INCOMPLETE',
        message: 'The export download was incomplete. Try again.',
      );
    case ExportDownloadResolution.identifiedStale:
      throw ApiException(
        code: 'EXPORT_REVISION_MISMATCH',
        message:
            'This ${export.format.toUpperCase()} belongs to an older '
            'version of your book. Refresh and try again.',
      );
    case ExportDownloadResolution.replacedUnderRead:
      throw const ApiException(
        code: 'EXPORT_PROVENANCE_MISMATCH',
        message: 'This file changed while it was downloading. Try again.',
      );
    case ExportDownloadResolution.unidentified:
      throw const ApiException(
        code: 'EXPORT_REVISION_MISMATCH',
        message:
            'This export no longer matches the version shown. Refresh and '
            'try again.',
      );
  }
}

final projectsRepositoryProvider = Provider<ProjectsRepository>((ref) {
  return MobileProjectsRepository(apiClient: ref.watch(apiClientProvider));
});

/// The signed-in user's books. Cached, deliberately not `autoDispose`.
///
/// The drawer's book shelf is mounted only while the drawer is open, so an
/// autoDispose list was thrown away on every close: reopening started from an
/// empty shelf and shoved the chat list down a frame later when the books
/// landed. Holding the last result lets consumers paint what they already know
/// and refresh behind it — `ref.invalidate` keeps the previous value on the
/// resulting loading state, which is what `AsyncValue.when` renders while the
/// request is in flight.
///
/// Because the cache outlives any one screen, it has to be cleared on sign-out;
/// `AuthController.logout` invalidates it with `asReload: true` so the next
/// account gets the loading state instead of the previous account's books.
final projectsProvider = FutureProvider<List<MobileProjectSummary>>((ref) {
  return ref.watch(projectsRepositoryProvider).listProjects();
});

final projectDetailProvider = FutureProvider.autoDispose
    .family<MobileProjectDetail, String>((ref, id) {
      return ref.watch(projectsRepositoryProvider).getProject(id);
    });

final projectStatusProvider = StreamProvider.autoDispose
    .family<MobileProjectStatus, String>((ref, id) {
      final pollDelay = _StatusPollDelay();
      ref.onDispose(pollDelay.dispose);
      return _watchProjectStatus(
        ref.watch(projectsRepositoryProvider),
        id,
        pollDelay,
        ref.watch(exportRepairWatchProvider(id)),
      );
    });

final projectChatProvider = FutureProvider.autoDispose
    .family<MobileProjectChat, String>((ref, id) {
      return ref.watch(projectsRepositoryProvider).getProjectChat(id);
    });

/// Identifies one applied edit, so its diff can be cached per operation.
typedef EditChangesRef = ({String projectId, String operationId});

final editChangesProvider = FutureProvider.autoDispose
    .family<MobileEditChanges, EditChangesRef>((ref, target) {
      return ref
          .watch(projectsRepositoryProvider)
          .getEditChanges(
            projectId: target.projectId,
            operationId: target.operationId,
          );
    });

final projectAssetHeadersProvider =
    FutureProvider.autoDispose<Map<String, String>>((ref) {
      return ref.watch(projectsRepositoryProvider).assetHeaders();
    });

String _safeLocalFilename(String filename, String format) {
  final fallback = 'book.$format';
  final cleaned = filename
      .replaceAll(RegExp(r'[/\\]+'), '-')
      .replaceAll(RegExp(r'[^A-Za-z0-9._ -]+'), '')
      .trim();
  return cleaned.isEmpty ? fallback : cleaned;
}

Map<String, dynamic> _reportPayload({required String reason, String? comment}) {
  return {
    'reason': reason,
    if (comment != null && comment.trim().isNotEmpty) 'comment': comment.trim(),
  };
}

Stream<MobileProjectStatus> _watchProjectStatus(
  ProjectsRepository repository,
  String id,
  _StatusPollDelay pollDelay,
  ExportRepairWatchBudget repairWatch,
) async* {
  try {
    await for (final status in repository.watchProjectStatus(id)) {
      yield status;
      if (!repairWatch.shouldKeepWatching(status)) {
        return;
      }
    }
    // Falling out while there is still something to watch means the socket
    // ended without saying so — a backgrounded app, a proxy idle timeout, a
    // network switch, or the API deliberately closing after it queued a settled
    // book's export repair. Drop through to polling instead.
  } catch (_) {
    // Older API builds, local proxies, or transient stream failures fall back
    // to short polling so progress and export repairs remain observable.
  }

  while (true) {
    final status = await repository.getProjectStatus(id);
    yield status;
    if (!repairWatch.shouldKeepWatching(status)) {
      return;
    }
    if (!await pollDelay.wait()) {
      return;
    }
  }
}

/// Owns the one pending short-poll delay so auto-disposing the provider also
/// cancels its timer. A bare `Future.delayed` keeps running after its stream
/// subscription is canceled, wasting work and leaving a timer behind when a
/// reader closes during an export repair.
class _StatusPollDelay {
  Timer? _timer;
  Completer<bool>? _pending;
  bool _disposed = false;

  Future<bool> wait() {
    if (_disposed) {
      return Future.value(false);
    }
    final pending = Completer<bool>();
    _pending = pending;
    _timer = Timer(const Duration(seconds: 3), () {
      _timer = null;
      _pending = null;
      pending.complete(true);
    });
    return pending.future;
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    final pending = _pending;
    _pending = null;
    if (pending != null && !pending.isCompleted) {
      pending.complete(false);
    }
  }
}

// A finished book can briefly have no PDF after an edit invalidates its old
// compile. The server queues a repair from the status read, so watching a
// missing PDF is what asks for the rebuild — and, for a repair that never
// lands, what keeps asking. `ExportRepairWatchBudget` (export_repair_watch.dart)
// meters that: it holds the decision per project, outside this stream, so the
// constant invalidations that rebuild the provider cannot hand a failing repair
// a fresh allowance several times a minute.
