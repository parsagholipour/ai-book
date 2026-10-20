import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';
import 'package:tomeza/shared/lifecycle/app_resume_signal.dart';

import 'chat_history_drawer_harness.dart';
import 'chat_session_page_fixture.dart';

void main() {
  late _ChangingChats chats;
  late _ChangingBilling billing;
  late _ChangingProjects projects;
  late StreamController<void> resumes;
  late List<Override> overrides;

  setUp(() {
    chats = _ChangingChats([chatSession(draftId: 'a', title: 'First chat')]);
    billing = _ChangingBilling(1200);
    projects = _ChangingProjects();
    resumes = StreamController<void>.broadcast();
    // One list, so remounting the drawer keeps the same ProviderScope and the
    // cache the bug lived in.
    overrides = [
      creationRepositoryProvider.overrideWithValue(chats),
      billingRepositoryProvider.overrideWithValue(billing),
      projectsRepositoryProvider.overrideWithValue(projects),
      projectStatusProvider.overrideWith(
        (ref, id) => const Stream<MobileProjectStatus>.empty(),
      ),
      appResumesProvider.overrideWithValue(resumes.stream),
    ];
  });

  tearDown(() => resumes.close());

  Widget app({required bool drawerOpen}) => ProviderScope(
    overrides: overrides,
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: Scaffold(
        body: Column(
          children: [
            // The home screen behind the drawer watches the balance too, which
            // is what kept an autoDispose provider's first answer alive.
            Consumer(
              builder: (context, ref, _) {
                ref.watch(billingProvider);
                return const SizedBox.shrink();
              },
            ),
            if (drawerOpen)
              const Expanded(child: ChatHistoryDrawer(activeDraftId: '')),
          ],
        ),
      ),
    ),
  );

  testWidgets('each opening refetches the chats and the balance behind what '
      'it already shows', (tester) async {
    await tester.pumpWidget(app(drawerOpen: true));
    await tester.pumpAndSettle();
    expect(find.text('First chat'), findsOneWidget);
    expect(find.text('1,200 credits'), findsOneWidget);

    await tester.pumpWidget(app(drawerOpen: false));
    await tester.pumpAndSettle();
    // Another phone starts a chat and spends credits.
    chats.sessions = [
      chatSession(draftId: 'b', title: 'From the other phone'),
      ...chats.sessions,
    ];
    billing.available = 900;
    final listCalls = chats.listCalls;

    await tester.pumpWidget(app(drawerOpen: true));
    // The first frame paints what the drawer already knew; nothing blanks.
    expect(find.text('First chat'), findsOneWidget);
    expect(find.text('1,200 credits'), findsOneWidget);

    await tester.pumpAndSettle();
    expect(find.text('From the other phone'), findsOneWidget);
    expect(find.text('900 credits'), findsOneWidget);
    expect(chats.listCalls, listCalls + 1);
  });

  testWidgets('coming back to an open drawer refetches it, books included', (
    tester,
  ) async {
    await tester.pumpWidget(app(drawerOpen: true));
    await tester.pumpAndSettle();
    final booksBefore = projects.listCalls;

    chats.sessions = [
      chatSession(draftId: 'b', title: 'From the other phone'),
      ...chats.sessions,
    ];
    billing.available = 700;
    resumes.add(null);
    await tester.pumpAndSettle();

    expect(find.text('From the other phone'), findsOneWidget);
    expect(find.text('700 credits'), findsOneWidget);
    expect(projects.listCalls, booksBefore + 1);
  });

  testWidgets('a first read still in flight is not asked twice', (
    tester,
  ) async {
    final gate = Completer<void>();
    chats.gate = gate;
    await tester.pumpWidget(app(drawerOpen: true));
    await tester.pump();
    await tester.pump();
    expect(chats.listCalls, 1);

    gate.complete();
    await tester.pumpAndSettle();
    expect(chats.listCalls, 1);
    expect(find.text('First chat'), findsOneWidget);
  });
}

class _ChangingChats
    with ListSessionsPageFromList
    implements CreationRepository {
  _ChangingChats(this.sessions);

  List<MobileChatSession> sessions;
  Completer<void>? gate;
  int listCalls = 0;

  @override
  Future<List<MobileChatSession>> listSessions() async {
    listCalls += 1;
    await gate?.future;
    return sessions;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class _ChangingBilling implements BillingRepository {
  _ChangingBilling(this.available);

  int available;

  @override
  Future<MobileBilling> getBilling() async {
    final billing = drawerBilling();
    return MobileBilling(
      credits: CreditBalance(
        available: available,
        reserved: 0,
        lifetimeGranted: available,
        lifetimeSpent: 0,
      ),
      entitlements: billing.entitlements,
      products: billing.products,
      creditCosts: billing.creditCosts,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class _ChangingProjects implements ProjectsRepository {
  int listCalls = 0;

  @override
  Future<List<MobileProjectSummary>> listProjects() async {
    listCalls += 1;
    return const [];
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
