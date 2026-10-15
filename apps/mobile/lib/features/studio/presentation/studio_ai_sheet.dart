import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../billing/data/billing_repository.dart';
import '../../projects/presentation/ai_content_report.dart';
import '../data/studio_repository.dart';
import '../domain/assist_models.dart';
import '../domain/assist_text.dart';
import 'studio_ai_billing.dart';
import 'studio_ai_results.dart';
import 'studio_ai_widgets.dart';
import 'studio_session.dart' show newStudioRequestId;

/// What one quick tool is asked, about which text.
class StudioQuickRequest {
  const StudioQuickRequest({
    required this.kind,
    required this.chapterId,
    required this.window,
    this.preset,
    this.instruction,
  });

  final QuickAssistKind kind;
  final String chapterId;
  final AssistWindow window;
  final RewritePreset? preset;

  /// A rewrite's own direction, the question asked, or the idea to write.
  final String? instruction;

  StudioQuickRequest copyWith({QuickAssistKind? kind, String? instruction}) =>
      StudioQuickRequest(
        kind: kind ?? this.kind,
        chapterId: chapterId,
        window: window,
        preset: preset,
        instruction: instruction ?? this.instruction,
      );

  /// The wire request; each run is a new [requestId], the same inputs.
  QuickAssistRequest toRequest(String requestId) {
    final keepsSelection = kind.needsSelection || kind == QuickAssistKind.ask;
    final direction = instruction?.trim();
    return QuickAssistRequest(
      kind: kind,
      chapterId: chapterId,
      requestId: requestId,
      selection: keepsSelection ? window.selection : null,
      before: window.before.isEmpty ? null : window.before,
      after: window.after.isEmpty ? null : window.after,
      preset: kind == QuickAssistKind.rewrite ? preset : null,
      instruction: direction == null || direction.isEmpty ? null : direction,
    );
  }
}

/// What the author accepted from the sheet. The screen applies it — after a
/// version checkpoint — through the text field's own controller, so the
/// field's Undo takes it back.
sealed class StudioAiAcceptance {
  const StudioAiAcceptance();
}

/// A rewrite or description, to replace the selection verbatim.
final class StudioAiReplacement extends StudioAiAcceptance {
  const StudioAiReplacement(this.text);

  final String text;
}

/// A continuation, to insert at the cursor verbatim.
final class StudioAiInsertion extends StudioAiAcceptance {
  const StudioAiInsertion(this.text);

  final String text;
}

/// The proofreading fixes the author kept.
final class StudioAiCorrections extends StudioAiAcceptance {
  const StudioAiCorrections(this.corrections);

  final List<AssistCorrection> corrections;
}

/// The suggestion sheet: runs one quick tool, shows what it suggests —
/// a word diff, a preview, a list of fixes, ideas, an answer — and resolves
/// with what the author accepted, or null. It never touches the text.
Future<StudioAiAcceptance?> showStudioQuickAssistSheet(
  BuildContext context, {
  required String projectId,
  required StudioQuickRequest request,
}) {
  return showAppBottomSheet<StudioAiAcceptance>(
    context,
    builder: (_) =>
        StudioQuickAssistSheet(projectId: projectId, request: request),
  );
}

enum _Phase { question, waiting, result, error }

class StudioQuickAssistSheet extends ConsumerStatefulWidget {
  const StudioQuickAssistSheet({
    required this.projectId,
    required this.request,
    super.key,
  });

  final String projectId;
  final StudioQuickRequest request;

  @override
  ConsumerState<StudioQuickAssistSheet> createState() =>
      _StudioQuickAssistSheetState();
}

class _StudioQuickAssistSheetState
    extends ConsumerState<StudioQuickAssistSheet> {
  late StudioQuickRequest _request = widget.request;
  late _Phase _phase;
  QuickAssistResult? _result;
  Object? _error;
  StudioAiRecovery _recovery = StudioAiRecovery.none;
  bool _outOfMessages = false;
  int _runs = 0;
  List<CorrectionPlacement> _placements = const [];
  Set<int> _checked = {};
  int? _openIdea;
  final _question = TextEditingController();

  QuickAssistKind get _kind => _request.kind;

  @override
  void initState() {
    super.initState();
    _question.addListener(() => setState(() {}));
    final asksFirst =
        _kind == QuickAssistKind.ask &&
        (_request.instruction?.trim().isEmpty ?? true);
    _phase = asksFirst ? _Phase.question : _Phase.waiting;
    if (!asksFirst) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_run());
      });
    }
  }

  @override
  void dispose() {
    _question.dispose();
    super.dispose();
  }

  Future<void> _run() async {
    final run = ++_runs;
    setState(() {
      _phase = _Phase.waiting;
      _error = null;
      _recovery = StudioAiRecovery.none;
      _outOfMessages = false;
    });
    final gate = ref.read(studioAiBillingGateProvider);
    final allowed = await gate.ensureMessages(context, ref);
    if (!mounted || run != _runs) return;
    if (!allowed) {
      setState(() {
        _phase = _Phase.error;
        _outOfMessages = true;
      });
      return;
    }
    try {
      final result = await ref
          .read(studioRepositoryProvider)
          .runQuickAssist(
            widget.projectId,
            _request.toRequest(newStudioRequestId('studio-assist')),
          );
      if (!mounted || run != _runs) return;
      // One message was spent: the allowance banner elsewhere reads it again.
      ref.invalidate(billingProvider);
      final placements = placeCorrections(
        _request.window.selection ?? '',
        result.corrections,
      );
      setState(() {
        _result = result;
        _placements = placements;
        _checked = {for (var i = 0; i < placements.length; i++) i};
        _openIdea = null;
        _phase = _Phase.result;
      });
    } catch (error) {
      if (!mounted || run != _runs) return;
      setState(() {
        _phase = _Phase.error;
        _error = error;
      });
      final recovery = await answerStudioBillingRefusal(
        context,
        ref,
        error,
        projectId: widget.projectId,
        reason: 'Using the writing assistant.',
      );
      if (!mounted || run != _runs) return;
      setState(() => _recovery = recovery);
    }
  }

  void _ask() {
    final question = _question.text.trim();
    if (question.isEmpty) return;
    _question.clear();
    _request = _request.copyWith(instruction: question);
    unawaited(_run());
  }

  void _writeIdea(AssistIdea idea) {
    final text = idea.text.trim();
    _request = _request.copyWith(
      kind: QuickAssistKind.continueWriting,
      instruction: text.isEmpty ? idea.title : '${idea.title}: $text',
    );
    unawaited(_run());
  }

  void _accept(StudioAiAcceptance acceptance) =>
      Navigator.of(context).pop(acceptance);

  String get _title {
    final preset = _request.preset;
    if (_kind == QuickAssistKind.rewrite && preset != null) {
      return 'Rewrite · ${preset.label}';
    }
    if (_kind == QuickAssistKind.ask && _request.window.selection == null) {
      return 'Ask about this chapter';
    }
    return _kind.label;
  }

  String? get _suggestion {
    final suggestions = _result?.suggestions ?? const [];
    return suggestions.isEmpty ? null : suggestions.first;
  }

  @override
  Widget build(BuildContext context) {
    return AppSheetScaffold(
      title: _title,
      icon: Icons.auto_awesome_outlined,
      onClose: () => Navigator.of(context).pop(),
      footer: _footer(),
      children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 220),
          child: KeyedSubtree(
            key: ValueKey('$_phase-$_runs'),
            child: _body(context),
          ),
        ),
      ],
    );
  }

  Widget _body(BuildContext context) {
    switch (_phase) {
      case _Phase.question:
        return _questionBody(context);
      case _Phase.waiting:
        return StudioAiWaiting(
          key: const ValueKey('studio-ai-waiting'),
          stages: studioQuickStages(_kind),
        );
      case _Phase.error:
        return _errorBody(context);
      case _Phase.result:
        final reportable = _reportableText();
        if (reportable == null) return _resultBody(context);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _resultBody(context),
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton.icon(
                key: const ValueKey('studio-ai-report'),
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  foregroundColor: Theme.of(
                    context,
                  ).colorScheme.onSurfaceVariant,
                ),
                icon: const Icon(Icons.flag_outlined, size: 18),
                label: const Text('Report'),
                onPressed: () => unawaited(_report(reportable)),
              ),
            ),
          ],
        );
    }
  }

  /// What the sheet showed, as text: the server keeps no copy of a quick
  /// suggestion, so a report carries it. Null when nothing was suggested.
  String? _reportableText() {
    final result = _result;
    if (result == null) return null;
    final text = switch (_kind) {
      QuickAssistKind.rewrite ||
      QuickAssistKind.describe ||
      QuickAssistKind.continueWriting => _suggestion ?? '',
      QuickAssistKind.proofread => [
        for (final fix in result.corrections)
          '${fix.find} → ${fix.replace}'
              '${fix.reason.trim().isEmpty ? '' : ' (${fix.reason.trim()})'}',
      ].join('\n'),
      QuickAssistKind.brainstorm => [
        for (final idea in result.ideas)
          idea.text.trim().isEmpty ? idea.title : '${idea.title}: ${idea.text}',
      ].join('\n'),
      QuickAssistKind.ask => result.answer ?? '',
    };
    return text.trim().isEmpty ? null : text;
  }

  Future<void> _report(String suggestion) => reportAiContent(
    context: context,
    title: 'Report this AI suggestion',
    submit: (reason, comment) => ref
        .read(aiContentReportsApiProvider)
        .reportStudioQuickSuggestion(
          projectId: widget.projectId,
          assistKind: _kind.wire,
          suggestion: suggestion,
          chapterId: _request.chapterId,
          selection: _request.window.selection,
          instruction: _request.instruction,
          reason: reason,
          comment: comment,
        ),
  );

  Widget _questionBody(BuildContext context) {
    final theme = Theme.of(context);
    final selection = _request.window.selection;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (selection != null) ...[
          StudioSuggestionSurface(
            child: Text(
              clipHead(plainAssistText(selection), 280),
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodyMedium?.copyWith(
                fontStyle: FontStyle.italic,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
        ],
        TextField(
          key: const ValueKey('studio-ai-question'),
          controller: _question,
          autofocus: true,
          minLines: 2,
          maxLines: 5,
          maxLength: 500,
          textCapitalization: TextCapitalization.sentences,
          decoration: InputDecoration(
            hintText: selection == null
                ? 'Does the ending of this chapter land?'
                : 'Is it clear who is speaking here?',
            counterText: '',
          ),
        ),
      ],
    );
  }

  Widget _errorBody(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final ready = _recovery == StudioAiRecovery.ready;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
      child: Column(
        children: [
          Icon(
            ready
                ? Icons.check_circle_outline_rounded
                : Icons.cloud_off_rounded,
            color: ready ? colors.primary : colors.onSurfaceVariant,
            size: 32,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            _errorText(),
            key: const ValueKey('studio-ai-error'),
            textAlign: TextAlign.center,
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }

  bool get _allowanceRefusal {
    final error = _error;
    return _outOfMessages ||
        (error is ApiException &&
            (error.code == 'MESSAGE_LIMIT_REACHED' ||
                error.code == 'INSUFFICIENT_CREDITS' ||
                error.statusCode == 402));
  }

  String _errorText() {
    if (_recovery == StudioAiRecovery.ready) {
      return 'You’re all set. Try again.';
    }
    if (_allowanceRefusal) return 'You’re out of messages for now.';
    return studioAiErrorMessage(_error ?? '');
  }

  Widget _resultBody(BuildContext context) {
    final result = _result!;
    switch (_kind) {
      case QuickAssistKind.rewrite || QuickAssistKind.describe:
        final suggestion = _suggestion;
        if (suggestion == null) return _emptyResult(context);
        return StudioRewriteResult(
          original: _request.window.selection ?? '',
          suggestion: suggestion,
        );
      case QuickAssistKind.continueWriting:
        final suggestion = _suggestion;
        if (suggestion == null) return _emptyResult(context);
        return StudioContinuationResult(
          before: _request.window.before,
          continuation: suggestion,
        );
      case QuickAssistKind.proofread:
        return StudioProofreadResult(
          selection: _request.window.selection ?? '',
          placements: _placements,
          checked: _checked,
          onToggle: (index, value) => setState(() {
            value ? _checked.add(index) : _checked.remove(index);
          }),
        );
      case QuickAssistKind.brainstorm:
        if (result.ideas.isEmpty) return _emptyResult(context);
        return StudioIdeasResult(
          ideas: result.ideas,
          open: _openIdea,
          onOpen: (index) =>
              setState(() => _openIdea = _openIdea == index ? null : index),
          onWrite: _writeIdea,
        );
      case QuickAssistKind.ask:
        final answer = result.answer?.trim() ?? '';
        if (answer.isEmpty) return _emptyResult(context);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StudioAnswerResult(
              question: _request.instruction ?? '',
              answer: answer,
            ),
            const SizedBox(height: AppSpacing.xs),
            TextField(
              key: const ValueKey('studio-ai-follow-up'),
              controller: _question,
              maxLength: 500,
              textCapitalization: TextCapitalization.sentences,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _ask(),
              decoration: InputDecoration(
                hintText: 'Ask a follow-up',
                counterText: '',
                suffixIcon: IconButton(
                  tooltip: 'Ask',
                  icon: const Icon(Icons.arrow_upward_rounded),
                  onPressed: _question.text.trim().isEmpty ? null : _ask,
                ),
              ),
            ),
          ],
        );
    }
  }

  Widget _emptyResult(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
    child: Text(
      'The writing assistant came back with nothing to show. Try again.',
      textAlign: TextAlign.center,
      style: Theme.of(context).textTheme.bodyLarge,
    ),
  );

  Widget? _footer() {
    Widget discard() => AppButton.text(
      key: const ValueKey('studio-ai-discard'),
      label: 'Discard',
      onPressed: () => Navigator.of(context).pop(),
    );
    Widget tryAgain() => AppButton.outlined(
      key: const ValueKey('studio-ai-try-again'),
      label: 'Try again',
      onPressed: () => unawaited(_run()),
    );
    switch (_phase) {
      case _Phase.question:
        return AppButton.primary(
          key: const ValueKey('studio-ai-ask'),
          label: 'Ask',
          expanded: true,
          onPressed: _question.text.trim().isEmpty ? null : _ask,
        );
      case _Phase.waiting:
        return AppButton.text(
          label: 'Close',
          expanded: true,
          onPressed: () => Navigator.of(context).pop(),
        );
      case _Phase.error:
        final retryable =
            _outOfMessages || _error == null || studioAiErrorRetryable(_error!);
        if (!retryable) {
          return AppButton.outlined(
            label: 'Close',
            expanded: true,
            onPressed: () => Navigator.of(context).pop(),
          );
        }
        return AppActionGroup(
          secondary: [
            AppButton.text(
              label: 'Close',
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
          primary: AppButton.primary(
            key: const ValueKey('studio-ai-try-again'),
            label: 'Try again',
            expanded: true,
            onPressed: () => unawaited(_run()),
          ),
        );
      case _Phase.result:
        return _resultFooter(discard, tryAgain);
    }
  }

  Widget _resultFooter(Widget Function() discard, Widget Function() tryAgain) {
    switch (_kind) {
      case QuickAssistKind.rewrite || QuickAssistKind.describe:
        final suggestion = _suggestion;
        return StudioAiActionRow(
          secondary: [discard(), tryAgain()],
          primary: AppButton.primary(
            key: const ValueKey('studio-ai-replace'),
            label: 'Replace',
            expanded: true,
            onPressed: suggestion == null
                ? null
                : () => _accept(StudioAiReplacement(suggestion)),
          ),
        );
      case QuickAssistKind.continueWriting:
        final suggestion = _suggestion;
        return StudioAiActionRow(
          secondary: [discard(), tryAgain()],
          primary: AppButton.primary(
            key: const ValueKey('studio-ai-insert'),
            label: 'Insert',
            expanded: true,
            onPressed: suggestion == null
                ? null
                : () => _accept(StudioAiInsertion(suggestion)),
          ),
        );
      case QuickAssistKind.proofread:
        if (_placements.isEmpty) {
          return AppButton.primary(
            label: 'Done',
            expanded: true,
            onPressed: () => Navigator.of(context).pop(),
          );
        }
        final count = _checked.length;
        return StudioAiActionRow(
          secondary: [discard(), tryAgain()],
          primary: AppButton.primary(
            key: const ValueKey('studio-ai-apply-fixes'),
            label: count == 1 ? 'Apply 1 fix' : 'Apply $count fixes',
            expanded: true,
            onPressed: count == 0
                ? null
                : () => _accept(
                    StudioAiCorrections([
                      for (var i = 0; i < _placements.length; i++)
                        if (_checked.contains(i)) _placements[i].correction,
                    ]),
                  ),
          ),
        );
      case QuickAssistKind.brainstorm || QuickAssistKind.ask:
        return StudioAiActionRow(
          secondary: [if (_kind == QuickAssistKind.brainstorm) tryAgain()],
          primary: AppButton.outlined(
            label: 'Done',
            expanded: true,
            onPressed: () => Navigator.of(context).pop(),
          ),
        );
    }
  }
}

/// What the waiting state says for [kind], in order.
List<String> studioQuickStages(QuickAssistKind kind) => switch (kind) {
  QuickAssistKind.rewrite => const [
    'Reading your passage…',
    'Rewriting it…',
    'Still working on it…',
  ],
  QuickAssistKind.proofread => const [
    'Reading your passage…',
    'Checking spelling and grammar…',
    'Still checking…',
  ],
  QuickAssistKind.continueWriting => const [
    'Reading your chapter…',
    'Writing what comes next…',
    'Still writing…',
  ],
  QuickAssistKind.describe => const [
    'Reading your passage…',
    'Adding what can be seen and heard…',
    'Still working on it…',
  ],
  QuickAssistKind.brainstorm => const [
    'Reading your chapter…',
    'Thinking about where it could go…',
    'Still thinking…',
  ],
  QuickAssistKind.ask => const [
    'Reading your chapter…',
    'Thinking it over…',
    'Still thinking…',
  ],
};
