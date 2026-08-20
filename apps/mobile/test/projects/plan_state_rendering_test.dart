import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_plan_review.dart';

void main() {
  testWidgets('plan review renders plan state and one question at a time', (
    tester,
  ) async {
    String? revisionMessage;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              ProjectPlanReview(
                project: fakeProjectWithPlan(),
                plan: fakePlan(),
                billing: fakeBilling(),
                revisionController: TextEditingController(),
                busyAction: null,
                onQuestionAnswers: (message) async {
                  revisionMessage = message;
                },
                onRevisionRequest: (_) async {},
                onApprovePlan: () async {},
              ),
            ],
          ),
        ),
      ),
    );

    expect(find.text('Launch Course Workbook'), findsOneWidget);
    expect(find.text('Premise'), findsOneWidget);
    expect(find.text('Audience'), findsOneWidget);
    expect(find.text('Set the promise'), findsOneWidget);
    expect(find.text('Build the weekly lessons'), findsOneWidget);
    expect(find.text('Question 1 of 2'), findsOneWidget);
    expect(find.text('Busy solo teachers'), findsOneWidget);
    expect(find.text('Question 2 of 2'), findsNothing);
    expect(find.text('Cover: Included'), findsOneWidget);
    expect(find.text('Illustrations: Not included'), findsOneWidget);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PlanQuestionsCard(
            plan: fakePlan(),
            onSubmitAnswers: (message) async {
              revisionMessage = message;
            },
          ),
        ),
      ),
    );

    expect(find.text('Question 1 of 2'), findsOneWidget);

    await tester.tap(find.text('Busy solo teachers'));
    await tester.tap(find.text('Next'));
    await tester.pump();

    expect(find.text('Question 2 of 2'), findsOneWidget);
    expect(find.text('Question 1 of 2'), findsNothing);

    await tester.tap(find.text('Skip'));
    await tester.pump();
    await tester.tap(find.text('Revise with answers'));
    await tester.pump();

    expect(revisionMessage, contains('Busy solo teachers'));
    expect(revisionMessage, contains('No preference.'));
  });

  // A question several chips answer at once keeps them all: the card used to
  // replace the previous pick, so the revision only ever heard the last chip.
  testWidgets('a multi-answer question revises with every chip picked', (
    tester,
  ) async {
    String? revisionMessage;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PlanQuestionsCard(
            plan: fakeMultiQuestionPlan(),
            onSubmitAnswers: (message) async {
              revisionMessage = message;
            },
          ),
        ),
      ),
    );

    expect(find.text('Pick as many as you like.'), findsOneWidget);

    await tester.tap(find.text('Forgiveness'));
    await tester.pump();
    await tester.tap(find.text('Justice'));
    await tester.pump();

    await tester.tap(find.text('Revise with answers'));
    await tester.pump();

    expect(revisionMessage, contains('Answer: Forgiveness, Justice'));
  });

  // A continuation whose outline call failed appends chapters with no title —
  // stored empty on purpose, rather than named in English for a book written in
  // another language. The tile rendered that as a blank heading over the summary.
  testWidgets('an unnamed chapter keeps its summary and drops the title row', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              ProjectPlanReview(
                project: fakeProjectWithPlan(),
                plan: fakePlanWithUnnamedChapter(),
                billing: fakeBilling(),
                revisionController: TextEditingController(),
                busyAction: null,
                onQuestionAnswers: (_) async {},
                onRevisionRequest: (_) async {},
                onApprovePlan: () async {},
              ),
            ],
          ),
        ),
      ),
    );

    expect(find.text('Set the promise'), findsOneWidget);
    expect(find.text('Continue from where the book left off.'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (widget) => widget is Text && (widget.data?.trim().isEmpty ?? false),
      ),
      findsNothing,
    );
  });
}

MobilePlan fakePlanWithUnnamedChapter() {
  final base = fakePlan();
  return MobilePlan(
    id: base.id,
    projectId: base.projectId,
    version: base.version,
    status: base.status,
    title: base.title,
    premise: base.premise,
    audience: base.audience,
    questions: base.questions,
    chapters: const [
      MobilePlanChapter(
        index: 1,
        title: 'Set the promise',
        summary: 'Define the result the student should get.',
        targetPages: 8,
      ),
      MobilePlanChapter(
        index: 2,
        title: '',
        summary: 'Continue from where the book left off.',
        targetPages: 4,
      ),
    ],
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  );
}

MobilePlan fakeMultiQuestionPlan() {
  final base = fakePlan();
  return MobilePlan(
    id: base.id,
    projectId: base.projectId,
    version: base.version,
    status: base.status,
    title: base.title,
    premise: base.premise,
    audience: base.audience,
    questions: const [
      MobilePlanQuestion(
        prompt: 'Which themes should the tales carry?',
        options: ['Forgiveness', 'Patience', 'Justice'],
        allowCustom: true,
        answerKind: QuestionAnswerKind.multi,
      ),
    ],
    chapters: base.chapters,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  );
}

MobileProjectDetail fakeProjectWithPlan() {
  return MobileProjectDetail(
    id: 'project-1',
    title: 'Launch Course Workbook',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    coverEnabled: true,
    illustrationsEnabled: false,
    status: 'plan_ready',
    statusLabel: 'Review your book plan',
    progressPercent: 20,
    currentAction: 'Ready for review.',
    promptPreview: 'Create a workbook for teachers launching a course.',
    targetPages: 28,
    pageCount: 0,
    imageCount: 0,
    hasPlan: true,
    exports: fakeExports,
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a workbook for teachers launching a course.',
    language: 'en',
    plan: fakePlan(),
    pages: const [],
  );
}

MobilePlan fakePlan() {
  return MobilePlan(
    id: 'plan-1',
    projectId: 'project-1',
    version: 1,
    status: 'draft',
    title: 'Launch Course Workbook',
    premise:
        'A practical workbook that turns course ideas into a simple paid launch.',
    audience: 'Independent teachers and coaches.',
    questions: const [
      MobilePlanQuestion(
        prompt: 'Who is the primary reader?',
        options: ['Busy solo teachers', 'New coaches'],
        allowCustom: true,
      ),
      MobilePlanQuestion(
        prompt: 'Should examples focus on live classes or recorded lessons?',
        options: ['Live classes', 'Recorded lessons'],
        allowCustom: true,
      ),
    ],
    chapters: const [
      MobilePlanChapter(
        index: 1,
        title: 'Set the promise',
        summary: 'Define the result the student should get.',
        targetPages: 8,
      ),
      MobilePlanChapter(
        index: 2,
        title: 'Build the weekly lessons',
        summary: 'Map each lesson to an exercise and checklist.',
        targetPages: 10,
      ),
    ],
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

MobileBilling fakeBilling() {
  return const MobileBilling(
    credits: CreditBalance(
      available: 1200,
      reserved: 0,
      lifetimeGranted: 1200,
      lifetimeSpent: 0,
    ),
    entitlements: [],
    products: [],
    creditCosts: {
      'fullBookBase': 350,
      'fullBookPerPage': 8,
      'imageGeneration': 45,
      'premiumReview': 200,
      'exportUnlock': 150,
    },
  );
}

const fakeExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'Launch-Course-Workbook.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'Launch-Course-Workbook.epub',
    contentType: 'application/epub+zip',
  ),
);
