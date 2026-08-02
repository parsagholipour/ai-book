import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_stage.dart';

void main() {
  test('a book with no plan asks for one', () {
    expect(
      bookStageFor(
        project: _project(status: 'draft'),
        status: _status(status: 'draft'),
      ),
      BookStage.needsPlan,
    );
  });

  test('an unapproved plan is the reader\'s decision', () {
    expect(
      bookStageFor(
        project: _project(status: 'plan_ready', plan: _plan()),
        status: _status(status: 'plan_ready'),
      ),
      BookStage.planReview,
    );
  });

  test('a plan_ready book is a review even before the detail loads', () {
    expect(
      bookStageFor(status: _status(status: 'plan_ready')),
      BookStage.planReview,
    );
  });

  test('an approved plan is a book being written, queued or not', () {
    // The approval has landed but the writing job has not reported in yet:
    // this is the beat where the old plan screen had nothing to show.
    expect(
      bookStageFor(
        project: _project(status: 'plan_ready', plan: _plan(approved: true)),
        status: _status(status: 'plan_ready'),
      ),
      BookStage.writing,
    );
    expect(
      bookStageFor(
        project: _project(status: 'generating', plan: _plan(approved: true)),
        status: _status(status: 'generating'),
      ),
      BookStage.writing,
    );
  });

  test('the live status wins over a stale project row', () {
    expect(
      bookStageFor(
        project: _project(status: 'generating', plan: _plan(approved: true)),
        status: _status(status: 'complete'),
      ),
      BookStage.ready,
    );
  });

  test('a failure needs attention, but a scheduled retry does not', () {
    expect(
      bookStageFor(
        project: _project(status: 'generating', plan: _plan(approved: true)),
        status: _status(status: 'generating', failureMessage: 'A page timed out.'),
      ),
      BookStage.needsAttention,
    );
    expect(
      bookStageFor(
        project: _project(status: 'generating', plan: _plan(approved: true)),
        status: _status(
          status: 'generating',
          failureMessage: 'A page timed out.',
          nextRetryAt: DateTime.utc(2026, 6, 15, 12, 5),
          retryState: 'scheduled',
        ),
      ),
      BookStage.writing,
    );
  });

  test('a blocked quality gate outranks a complete book', () {
    expect(
      bookStageFor(
        project: _project(status: 'complete', plan: _plan(approved: true)),
        status: _status(
          status: 'complete',
          quality: const MobileProjectQuality(
            state: 'blocked',
            issues: [],
            affectedPageIndexes: [3],
          ),
        ),
      ),
      BookStage.reviewRequired,
    );
  });

  test('only a plan under review leads the page with the plan', () {
    expect(BookStage.planReview.leadsWithPlan, isTrue);
    for (final stage in BookStage.values) {
      if (stage == BookStage.planReview) continue;
      expect(stage.leadsWithPlan, isFalse, reason: '$stage');
    }
  });
}

MobileProjectDetail _project({required String status, MobilePlan? plan}) {
  return MobileProjectDetail(
    id: 'project-1',
    title: 'Launch Course Workbook',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: status,
    statusLabel: 'Status',
    progressPercent: 20,
    currentAction: 'Working.',
    promptPreview: 'A workbook.',
    targetPages: 28,
    pageCount: 0,
    imageCount: 0,
    hasPlan: plan != null,
    exports: _exports,
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'A workbook.',
    language: 'en',
    plan: plan,
    pages: const [],
  );
}

MobilePlan _plan({bool approved = false}) {
  return MobilePlan(
    id: 'plan-1',
    projectId: 'project-1',
    version: 1,
    status: approved ? 'approved' : 'draft',
    title: 'Launch Course Workbook',
    premise: 'A compact guide.',
    audience: 'Teachers.',
    questions: const [],
    chapters: const [
      MobilePlanChapter(
        index: 1,
        title: 'Set the promise',
        summary: 'Define the result.',
        targetPages: 8,
      ),
    ],
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    approvedAt: approved ? DateTime.utc(2026, 6, 15) : null,
  );
}

MobileProjectStatus _status({
  required String status,
  String? failureMessage,
  DateTime? nextRetryAt,
  String? retryState,
  MobileProjectQuality quality = const MobileProjectQuality.pending(),
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: status,
    statusLabel: 'Status',
    progressPercent: 38,
    currentAction: 'Working.',
    retryAvailable: failureMessage != null,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 3, target: 28),
    imageCount: 0,
    exports: _exports,
    quality: quality,
    updatedAt: DateTime.utc(2026, 6, 15),
    failureMessage: failureMessage,
    nextRetryAt: nextRetryAt,
    retryState: retryState,
  );
}

const _exports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);
