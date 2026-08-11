import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_chat_screen.dart';

import '../billing/billing_paywall_harness.dart';

// The dead end this guards against: an edit was refused for credits, the user
// bought credits from the reply's own button, the sheet closed — and the chat
// sat unchanged, telling them to start over. A successful top-up must instead
// be followed up in the chat, with a Proceed that runs the blocked edit via
// the fresh proposal the server re-emitted on the refusal reply.
void main() {
  testWidgets(
    'a top-up bought from an insufficient-credits reply offers to run '
    'the blocked edit',
    (tester) async {
      final repository = _CreditsBlockedRepository();
      final store = FakeStoreBillingClient();
      final billing = FakeBillingRepository();
      await tester.pumpWidget(
        _app(repository, store: store, billing: billing),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('You need 660 credits'), findsOneWidget);
      await tester.tap(find.text('Add credits'));
      await tester.pumpAndSettle();

      // Buy the pack that covers the shortfall (100 held + 1000 granted).
      final sheetScrollable = find
          .descendant(
            of: find.byType(BillingPaywall),
            matching: find.byType(Scrollable),
          )
          .first;
      final creditPack = find.byKey(
        const ValueKey('paywall-topup-tomeza.credit_pack_1'),
      );
      await tester.scrollUntilVisible(
        creditPack,
        200,
        scrollable: sheetScrollable,
      );
      final buyButton = find.descendant(
        of: creditPack,
        matching: find.byType(FilledButton),
      );
      await tester.ensureVisible(buyButton);
      await tester.pumpAndSettle();
      await tester.tap(buyButton);
      await tester.pump();
      store.emit(
        const StorePurchaseUpdate(
          productId: 'tomeza.credit_pack_1',
          status: StorePurchaseStatus.purchased,
          purchaseToken: 'purchase-token-1',
          purchaseId: 'order-1',
          pendingCompletePurchase: true,
        ),
      );
      await tester.pumpAndSettle();

      final successDialog = find.byKey(
        const ValueKey('billing-purchase-success-dialog'),
      );
      expect(successDialog, findsOneWidget);
      await tester.tap(
        find.descendant(of: successDialog, matching: find.byType(FilledButton)),
      );
      await tester.pumpAndSettle();

      // The chat follows up instead of going quiet.
      expect(find.text('You now have enough credits.'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('credits-ready-proceed')));
      await tester.pumpAndSettle();

      expect(repository.appliedProposalIds, ['proposal-fresh']);
      expect(find.text('You now have enough credits.'), findsNothing);
    },
  );
}

Widget _app(
  _CreditsBlockedRepository repository, {
  required FakeStoreBillingClient store,
  required FakeBillingRepository billing,
}) {
  return ProviderScope(
    overrides: [
      projectsRepositoryProvider.overrideWithValue(repository),
      storeBillingClientProvider.overrideWithValue(store),
      billingRepositoryProvider.overrideWithValue(billing),
      creditLogRepositoryProvider.overrideWithValue(EmptyCreditLogRepository()),
    ],
    child: const MaterialApp(
      home: ProjectChatScreen(projectId: 'project-1'),
    ),
  );
}

/// A chat whose last turn is the server's insufficient-credits reply, carrying
/// the fresh resumable proposal it re-emits alongside the shortfall.
class _CreditsBlockedRepository implements ProjectsRepository {
  final appliedProposalIds = <String>[];
  final statusController = StreamController<MobileProjectStatus>.broadcast();

  MobileProjectChatMessage _message({
    required String id,
    required String? parentId,
    required String role,
    required String content,
    Map<String, dynamic> metadata = const {},
  }) {
    return MobileProjectChatMessage(
      id: id,
      projectId: 'project-1',
      parentId: parentId,
      role: role,
      content: content,
      metadata: metadata,
      createdAt: DateTime.utc(2026, 8, 11),
    );
  }

  MobileProjectChat _chat() {
    return MobileProjectChat(
      messages: [
        _message(
          id: 'm0',
          parentId: null,
          role: 'user',
          content: 'make 5 pages',
        ),
        _message(
          id: 'm1',
          parentId: 'm0',
          role: 'assistant',
          content:
              'You need 660 credits for that edit, but you have 100. '
              'Add credits, then tap Apply and I’ll run it.',
          metadata: const {
            'insufficientCredits': {
              'requiredCredits': 660,
              'availableCredits': 100,
              'reservedCredits': 0,
            },
            'pendingEdit': {
              'request': 'make 5 pages',
              'clarification': 'confirm',
              'credits': 660,
              'proposalId': 'proposal-fresh',
            },
            'editProposal': {
              'id': 'proposal-fresh',
              'kind': 'book_replan',
              'scope': 'all_pages',
              'credits': 660,
              'summary': 'Rebuild as a new 5-page copy',
              'affectedPageIndexes': <int>[],
            },
          },
        ),
      ],
      operations: const [],
    );
  }

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    return _chat();
  }

  @override
  Future<MobileProjectChatSendResult> applyEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    appliedProposalIds.add(proposalId);
    final chat = _chat();
    return MobileProjectChatSendResult(
      messages: chat.messages,
      operations: chat.operations,
      reply: _message(
        id: 'm2',
        parentId: 'm1',
        role: 'assistant',
        content: 'I’ll rebuild the plan and regenerate the book.',
      ),
    );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) =>
      statusController.stream;

  @override
  Future<MobileProjectDetail> getProject(String id) {
    // Keeps the app bar on its 'Book chat' fallback title.
    return Future<MobileProjectDetail>.error(
      UnimplementedError('Project detail is not used in this test.'),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
