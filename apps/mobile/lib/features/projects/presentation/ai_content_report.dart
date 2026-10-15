import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import 'book_preview_section.dart';

/// Reporting what an AI made outside a finished book's own page: a chat reply
/// (the book chat's or the creation chat's), a voice call, a book plan, a drawn
/// picture of a saved character, and a Writing Studio suggestion.
///
/// Google Play's generative-AI policy wants every surface that shows AI output
/// reportable in the app. Books and pictures already were, through the book
/// page; these were not. All of them reuse that page's report dialog, and the
/// server keeps a snapshot of what was shown so a review still has it after the
/// chat moves on, the plan is revised or the suggestion is discarded.
class AiContentReportsApi {
  const AiContentReportsApi(this._api);

  final ApiClient _api;

  Future<void> reportChatReply({
    required String projectId,
    required String messageId,
    required String reason,
    String? comment,
  }) async {
    await _api.postMap(
      '/api/mobile/projects/$projectId/chat/messages/$messageId/reports',
      data: _payload(reason, comment),
    );
  }

  /// A reply in the creation chat, before (or beside) any book: the draft is
  /// the chat session.
  Future<void> reportCreationReply({
    required String draftId,
    required String messageId,
    required String reason,
    String? comment,
  }) async {
    await _api.postMap(
      '/api/mobile/creation-sessions/$draftId/messages/$messageId/reports',
      data: _payload(reason, comment),
    );
  }

  /// A book plan as its card shows it.
  Future<void> reportPlan({
    required String projectId,
    required String planId,
    required String reason,
    String? comment,
  }) async {
    await _api.postMap(
      '/api/mobile/projects/$projectId/plans/$planId/reports',
      data: _payload(reason, comment),
    );
  }

  /// A drawn picture of a saved character. The server refuses an upload.
  Future<void> reportCharacterPicture({
    required String characterId,
    required String imageId,
    required String reason,
    String? comment,
  }) async {
    await _api.postMap(
      '/api/mobile/characters/$characterId/images/$imageId/reports',
      data: _payload(reason, comment),
    );
  }

  /// A Writing Studio suggestion the server stored: a picture, a chapter
  /// draft, notes or an outline.
  Future<void> reportStudioAssist({
    required String projectId,
    required String assistId,
    required String reason,
    String? comment,
  }) async {
    await _api.postMap(
      '/api/mobile/projects/$projectId/manuscript/assists/$assistId/reports',
      data: _payload(reason, comment),
    );
  }

  /// A quick Writing Studio suggestion. The server keeps no copy of these, so
  /// the report carries the text the sheet showed and what it was asked about.
  Future<void> reportStudioQuickSuggestion({
    required String projectId,
    required String assistKind,
    required String suggestion,
    required String reason,
    String? chapterId,
    String? selection,
    String? instruction,
    String? comment,
  }) async {
    final direction = instruction?.trim() ?? '';
    await _api.postMap(
      '/api/mobile/projects/$projectId/manuscript/assist/reports',
      data: {
        ..._payload(reason, comment),
        'assistKind': assistKind,
        'suggestion': _clip(suggestion.trim(), studioSuggestionReportMax),
        'chapterId': ?chapterId,
        if (selection != null && selection.isNotEmpty)
          'selection': _clip(selection, studioSelectionReportMax),
        if (direction.isNotEmpty)
          'instruction': _clip(direction, studioInstructionReportMax),
      },
    );
  }

  Future<void> reportVoiceCall({
    required String callId,
    required String reason,
    String? comment,
  }) async {
    await _api.postMap(
      '/api/mobile/voice/calls/$callId/reports',
      data: _payload(reason, comment),
    );
  }

  Map<String, Object> _payload(String reason, String? comment) => {
    'reason': reason,
    if (comment != null && comment.trim().isNotEmpty) 'comment': comment.trim(),
  };

  static String _clip(String text, int max) =>
      text.length <= max ? text : text.substring(0, max);
}

/// The server's ceilings on a quick-suggestion report
/// (`studioQuickSuggestionReportBodySchema` in `apps/api/src/aiOutputReports.ts`).
/// Clipped here rather than refused there: a report is still worth sending
/// when the passage was long.
const studioSuggestionReportMax = 12000;
const studioSelectionReportMax = 6000;
const studioInstructionReportMax = 500;

final aiContentReportsApiProvider = Provider<AiContentReportsApi>(
  (ref) => AiContentReportsApi(ref.watch(apiClientProvider)),
);

/// Asks for a reason, sends the report and says how it went.
Future<void> reportAiContent({
  required BuildContext context,
  required String title,
  required Future<void> Function(String reason, String? comment) submit,
}) async {
  final request = await showDialog<ContentReportRequest>(
    context: context,
    builder: (context) => ContentReportDialog(title: title),
  );
  if (request == null || !context.mounted) {
    return;
  }
  try {
    await submit(request.reason, request.comment);
    if (!context.mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showAppSnackBar(const SnackBar(content: Text('Report sent for review.')));
  } catch (error) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
  }
}
