import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:open_filex/open_filex.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/api/export_provenance.dart';
import '../../../shared/lifecycle/app_resume_signal.dart';
import '../../../shared/storage/app_files.dart';
import '../../../shared/storage/file_transfer.dart';
import '../domain/project_models.dart';
import 'export_repair_watch.dart';
import 'offline_library_store.dart';
import 'project_snapshot_cache.dart';
import 'project_status_watch.dart';

enum ExportOpenOutcome { opened, sharedFallback }

/// The iOS uniform type identifier for a compiled export, so the system can
/// pick a viewer. A format the enum does not know is handed over as plain data.
String exportUniformTypeIdentifier(String format) =>
    ExportRepairFormat.fromFormat(format)?.uniformTypeIdentifier ??
    'public.data';

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
    void Function(String text)? onAssistantText,
    required String projectId,
    required String message,
    String? requestId,
    String? replyToMessageId,
    List<String>? mentionedCharacterIds,
    Map<String, Object>? readerContext,
  });

  Future<MobileProjectChatSendResult> editProjectChatMessage({
    void Function(String text)? onAssistantText,
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

  Future<MobileProjectChatSendResult> redoLastBookEdit({
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

  /// The status event stream. A transformer rather than an `async*` loop, so
  /// a cancel reaches the socket at once (see `getServerSentEvents`). Comment
  /// lines (the `: ping` heartbeat) never arrive here; an `error` event that
  /// ends the stream is turned into an error the watch can act on (see
  /// [statusStreamEnding]), and one that does not is skipped.
  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) {
    return apiClient
        .getServerSentEvents(
          '/api/mobile/projects/$id/status/events',
          idleTimeout: statusStreamIdleTimeout,
        )
        .transform(
          StreamTransformer<ServerSentEvent, MobileProjectStatus>.fromHandlers(
            handleData: (event, sink) {
              try {
                switch (event.event) {
                  case 'status':
                    final decoded =
                        jsonDecode(event.data) as Map<String, dynamic>;
                    final status = decoded['status'] is Map<String, dynamic>
                        ? decoded['status'] as Map<String, dynamic>
                        : decoded;
                    sink.add(MobileProjectStatus.fromJson(status));
                  case 'error':
                    final ending = statusStreamEnding(event.data);
                    if (ending != null) sink.addError(ending);
                }
              } catch (error, stackTrace) {
                sink.addError(error, stackTrace);
              }
            },
          ),
        );
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
    void Function(String text)? onAssistantText,
    required String projectId,
    required String message,
    String? requestId,
    String? replyToMessageId,
    List<String>? mentionedCharacterIds,
    Map<String, Object>? readerContext,
  }) async {
    final data = await apiClient.postChatMap(
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
      onAssistantText: onAssistantText,
    );
    return MobileProjectChatSendResult.fromJson(data);
  }

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    void Function(String text)? onAssistantText,
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
    List<String>? mentionedCharacterIds,
  }) async {
    final data = await apiClient.postChatMap(
      '/api/mobile/projects/$projectId/chat/messages',
      data: {
        'message': message,
        'editMessageId': messageId,
        'requestId': ?requestId,
        if (mentionedCharacterIds != null && mentionedCharacterIds.isNotEmpty)
          'mentionedCharacterIds': mentionedCharacterIds,
      },
      onAssistantText: onAssistantText,
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
  Future<MobileProjectChatSendResult> redoLastBookEdit({
    required String projectId,
    String? requestId,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/projects/$projectId/chat/edits/redo',
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
    final exportDirectory = appDirectory(
      '${directory.path}/tomeza_exports/$safeProjectId',
    );
    if (!await exportDirectory.exists()) {
      await exportDirectory.create(recursive: true);
    }
    final filename = _safeLocalFilename(export.filename, export.format);
    final path = '${exportDirectory.path}/$filename';
    final partial = appFile('$path.part');
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
      final existing = appFile(path);
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
    if (kIsWeb) {
      await shareableFile(file.path, mimeType: export.contentType,
          name: file.filename).saveTo(file.filename);
      return ExportOpenOutcome.opened;
    }
    final result = await OpenFilex.open(
      file.path,
      type: export.contentType,
      uti: exportUniformTypeIdentifier(export.format),
    );
    if (result.type == ResultType.done) {
      return ExportOpenOutcome.opened;
    }
    await SharePlus.instance.share(
      ShareParams(
        title: file.filename,
        subject: file.filename,
        files: [shareableFile(file.path, mimeType: export.contentType)],
        fileNameOverrides: [file.filename],
      ),
    );
    return ExportOpenOutcome.sharedFallback;
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
///
/// Every list the server sends is also written to the phone, and a read that
/// cannot reach the server answers with that copy instead of an error, so a
/// reader with no connection still has their library and its downloaded
/// books. [OfflineLibraryMarker] says which one the answer was: the library
/// shows it as the phone's copy, and never draws its running books as live.
final projectsProvider = FutureProvider<List<MobileProjectSummary>>((
  ref,
) async {
  final store = ref.watch(offlineLibraryStoreProvider);
  final marker = ref.watch(offlineLibraryMarkerProvider);
  final epoch = store.epoch;
  try {
    final projects = await ref.watch(projectsRepositoryProvider).listProjects();
    marker.savedAt = null;
    unawaited(store.saveLibrary(projects, epoch: epoch));
    return projects;
  } catch (error) {
    if (!isOfflineFailure(error)) rethrow;
    final saved = await store.loadLibrary();
    if (saved == null) rethrow;
    marker.savedAt = saved.savedAt;
    return saved.books;
  }
});

final projectDetailProvider = FutureProvider.autoDispose
    .family<MobileProjectDetail, String>((ref, id) async {
      final cache = ref.watch(projectSnapshotCacheProvider);
      final project = await ref
          .watch(projectsRepositoryProvider)
          .getProject(id);
      if (ref.mounted) cache.details[id] = project;
      return project;
    });

final projectStatusProvider = StreamProvider.autoDispose
    .family<MobileProjectStatus, String>((ref, id) {
      final cache = ref.watch(projectSnapshotCacheProvider);
      // A status that offers a PDF is the descriptor the reader opens that
      // book against with no connection (`offlineBookStatusProvider`); the
      // store writes it only when the PDF it names changes.
      final offline = ref.watch(offlineLibraryStoreProvider);
      final offlineEpoch = offline.epoch;
      final pollDelay = StatusPollDelay();
      ref.onDispose(pollDelay.dispose);
      MobileProjectStatus? latest;
      // Back from the background, a live book's socket may have died with
      // the radio, and a watch that never got a status may have been waiting
      // out an outage the phone slept through. Either is opened afresh; a
      // settled book's watch has finished and stays finished.
      final resumes = ref.watch(appResumesProvider).listen((_) {
        if (latest == null || latest!.isLive) ref.invalidateSelf();
      });
      ref.onDispose(resumes.cancel);
      return watchProjectStatusWithFallback(
        ref.watch(projectsRepositoryProvider),
        id,
        pollDelay,
        ref.watch(exportRepairWatchProvider(id)),
      ).map((status) {
        latest = status;
        if (ref.mounted) cache.statuses[id] = status;
        unawaited(offline.saveStatus(status, epoch: offlineEpoch));
        return status;
      });
    });

final projectChatProvider = FutureProvider.autoDispose
    .family<MobileProjectChat, String>((ref, id) async {
      final cache = ref.watch(projectSnapshotCacheProvider);
      final chat = await ref
          .watch(projectsRepositoryProvider)
          .getProjectChat(id);
      if (ref.mounted) cache.chats[id] = chat;
      return chat;
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

// A finished book can briefly have no PDF after an edit invalidates its old
// compile. The server queues a repair from the status read, so watching a
// missing PDF is what asks for the rebuild — and, for a repair that never
// lands, what keeps asking. `ExportRepairWatchBudget` (export_repair_watch.dart)
// meters that: it holds the decision per project, outside this stream, so the
// constant invalidations that rebuild the provider cannot hand a failing repair
// a fresh allowance several times a minute.
