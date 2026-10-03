import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import 'book_preview_section.dart';

/// Reporting what an AI said outside a book: a chat reply and a voice call.
///
/// Google Play's generative-AI policy wants every surface that shows AI output
/// reportable in the app. Books and pictures already were, through the book
/// page; these two were not. Both reuse that page's report dialog, and the
/// server keeps a snapshot of what was said so a review still has it after the
/// chat moves on or the call ends.
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
}

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
