import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_annotation_geometry.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';
import 'package:tomeza/features/reader/domain/reader_reanchor.dart';
import 'package:tomeza/features/reader/domain/reader_settings.dart';
import 'package:tomeza/features/reader/presentation/reader_annotation_controller.dart';

class MemoryReaderRepository implements ReaderRepository {
  List<ReaderAnnotation> annotations = const [];
  ReaderSettings settings = const ReaderSettings();
  int annotationWrites = 0;

  @override
  Future<List<ReaderAnnotation>> loadAnnotations(String projectId) async =>
      annotations;

  @override
  Future<void> saveAnnotations(
    String projectId,
    List<ReaderAnnotation> next,
  ) async {
    annotations = next;
    annotationWrites++;
  }

  @override
  Future<ReaderSettings> loadSettings() async => settings;

  @override
  Future<void> saveSettings(ReaderSettings next) async => settings = next;

  @override
  Future<void> clearProject(String projectId) async {}

  @override
  Future<CachedExport> ensureExport({
    required String projectId,
    required MobileExportAvailability export,
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
    MobilePdfPageNumbering? pageNumbering,
  }) => throw UnimplementedError();

  @override
  Future<ReaderState> loadState(String projectId) async => const ReaderState();

  @override
  Future<void> saveState(String projectId, ReaderState state) async {}

  @override
  Future<ReaderPageLocator> pageLocator({
    required String projectId,
    required int revision,
  }) => throw UnimplementedError();
}

Future<ReaderAnnotationController> loaded(
  MemoryReaderRepository repository,
) async {
  final controller = ReaderAnnotationController(
    repository: repository,
    projectId: 'project-1',
    revision: 1,
  );
  await controller.load();
  return controller;
}

const stroke = InkStroke(
  points: [NormPoint(0.1, 0.5), NormPoint(0.9, 0.5)],
  colorIndex: 4,
  width: 0.004,
);

/// A page a re-anchoring search can actually find something in.
class _SearchablePage implements ReanchorPage {
  _SearchablePage(this.fullText);

  @override
  final String fullText;

  @override
  List<NormRect> rectsForRange(int start, int end) => const [
    NormRect(0.1, 0.3, 0.4, 0.02),
  ];
}

void main() {
  test(
    'refuses to stamp markup before the displayed revision is exact',
    () async {
      final repository = MemoryReaderRepository();
      final controller = ReaderAnnotationController(
        repository: repository,
        projectId: 'project-1',
        revision: null,
      );
      addTearDown(controller.dispose);
      await controller.load();

      expect(
        controller.addTextMarkup(
          page: 1,
          style: ReaderMarkupStyle.highlight,
          rects: const [NormRect(0, 0, 1, 0.02)],
          quote: 'unverified passage',
        ),
        isNull,
      );
      expect(
        controller.addNote(
          page: 1,
          anchor: const NormPoint(0.2, 0.2),
          body: 'unverified note',
        ),
        isNull,
      );
      expect(
        controller.addTextBox(
          page: 1,
          anchor: const NormPoint(0.3, 0.3),
          body: 'unverified text',
        ),
        isNull,
      );
      expect(controller.addStroke(page: 1, stroke: stroke), isNull);
      controller.setTool(ReaderTool.pen);
      controller.beginMove('old-note');
      expect(controller.tool, ReaderTool.none);
      expect(controller.pendingMoveId, isNull);
      expect(controller.isMarkingUp, isFalse);
      expect(controller.all, isEmpty);
      expect(repository.annotationWrites, 0);
    },
  );

  test('a page with nothing on it costs nothing to draw', () async {
    final controller = await loaded(MemoryReaderRepository());
    addTearDown(controller.dispose);

    controller.addStroke(page: 2, stroke: stroke);

    expect(controller.onPage(2), hasLength(1));
    expect(controller.onPage(3), isEmpty);
    expect(identical(controller.onPage(3), controller.onPage(9)), isTrue);
  });

  test('deleted and orphaned markup is kept but not drawn', () async {
    final repository = MemoryReaderRepository()
      ..annotations = [
        TextMarkupAnnotation(
          id: 'gone',
          page: 1,
          revision: 1,
          colorIndex: 0,
          createdAt: DateTime.utc(2026),
          updatedAt: DateTime.utc(2026),
          style: ReaderMarkupStyle.highlight,
          rects: const [NormRect(0, 0, 1, 0.02)],
          quote: 'lost passage',
          orphaned: true,
        ),
      ];
    final controller = await loaded(repository);
    addTearDown(controller.dispose);

    expect(controller.onPage(1), isEmpty, reason: 'nowhere to put it');
    expect(controller.all, hasLength(1), reason: 'still the reader’s note');
    expect(controller.orphaned, hasLength(1));
    expect(controller.count, 1);
  });

  test(
    'the eraser takes the stroke under the finger and nothing else',
    () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      controller.addStroke(page: 1, stroke: stroke);
      controller.addStroke(
        page: 1,
        stroke: const InkStroke(
          points: [NormPoint(0.1, 0.9), NormPoint(0.9, 0.9)],
          colorIndex: 4,
          width: 0.004,
        ),
      );

      expect(
        controller.eraseAt(page: 1, point: const NormPoint(0.5, 0.5)),
        isTrue,
      );
      expect(controller.onPage(1), hasLength(1));

      expect(
        controller.eraseAt(page: 1, point: const NormPoint(0.5, 0.2)),
        isFalse,
        reason: 'nothing is there',
      );
      expect(
        controller.eraseAt(page: 2, point: const NormPoint(0.5, 0.9)),
        isFalse,
        reason: 'a stroke on another page is not under the finger',
      );
    },
  );

  group('tapping your own markup', () {
    test('a tap on a highlight finds it', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      final mark = controller.addTextMarkup(
        page: 3,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0.1, 0.30, 0.6, 0.02)],
        quote: 'a passage',
      );

      // A line of type is around two percent of a page tall, so the hit target
      // has to be bigger than the thing drawn or nothing would ever be tapped.
      expect(
        controller.annotationAt(3, const NormPoint(0.4, 0.31))?.id,
        mark!.id,
      );
      expect(
        controller.annotationAt(3, const NormPoint(0.4, 0.60)),
        isNull,
        reason: 'a tap elsewhere on the page is a tap on the book',
      );
      expect(
        controller.annotationAt(4, const NormPoint(0.4, 0.31)),
        isNull,
        reason: 'markup belongs to one page',
      );
    });

    test('the topmost mark wins when two overlap', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0.1, 0.3, 0.6, 0.02)],
        quote: 'underneath',
      );
      final onTop = controller.addNote(
        page: 1,
        anchor: const NormPoint(0.3, 0.3),
        body: 'on top',
      );

      expect(
        controller.annotationAt(1, const NormPoint(0.32, 0.31))?.id,
        onTop!.id,
      );
    });

    test('a drawing is tappable along its stroke, not just its ends', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      final drawn = controller.addStroke(page: 2, stroke: stroke)!;

      expect(
        controller.annotationAt(2, const NormPoint(0.5, 0.5))?.id,
        drawn.id,
      );
      expect(controller.annotationAt(2, const NormPoint(0.5, 0.9)), isNull);
    });

    test('orphaned markup cannot be tapped, because it is not drawn', () async {
      final repository = MemoryReaderRepository()
        ..annotations = [
          TextMarkupAnnotation(
            id: 'lost',
            page: 1,
            revision: 1,
            colorIndex: 0,
            createdAt: DateTime.utc(2026),
            updatedAt: DateTime.utc(2026),
            style: ReaderMarkupStyle.highlight,
            rects: const [NormRect(0.1, 0.3, 0.6, 0.02)],
            quote: 'a rewritten passage',
            orphaned: true,
          ),
        ];
      final controller = await loaded(repository);
      addTearDown(controller.dispose);

      expect(controller.annotationAt(1, const NormPoint(0.4, 0.31)), isNull);
    });
  });

  group('highlighting the same words twice', () {
    test('replaces rather than stacking a second layer', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      final first = controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0.1, 0.3, 0.6, 0.02)],
        quote: 'a passage',
        colorIndex: 0,
      );
      final second = controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0.2, 0.3, 0.3, 0.02)],
        quote: 'a passage',
        colorIndex: 2,
      );

      // Two translucent layers over one line read as a third, darker colour,
      // and the index would list the passage twice.
      expect(controller.onPage(1), hasLength(1));
      expect(controller.onPage(1).single.id, second!.id);
      expect(controller.onPage(1).single.colorIndex, 2);
      expect(
        controller.all.map((entry) => entry.id),
        isNot(contains(first!.id)),
      );
    });

    test('an underline through a highlight is two deliberate marks', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0.1, 0.3, 0.6, 0.02)],
        quote: 'a passage',
      );
      controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.underline,
        rects: const [NormRect(0.1, 0.3, 0.6, 0.02)],
        quote: 'a passage',
      );

      expect(controller.onPage(1), hasLength(2));
    });

    test('markup elsewhere on the page is left alone', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0.1, 0.10, 0.6, 0.02)],
        quote: 'the first passage',
      );
      controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0.1, 0.70, 0.6, 0.02)],
        quote: 'the second passage',
      );

      expect(controller.onPage(1), hasLength(2));
    });

    test('replacing is one undo away, not two', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      final first = controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0.1, 0.3, 0.6, 0.02)],
        quote: 'a passage',
        colorIndex: 0,
      );
      controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0.1, 0.3, 0.6, 0.02)],
        quote: 'a passage',
        colorIndex: 3,
      );

      controller.undo();

      expect(controller.onPage(1), hasLength(1));
      expect(controller.onPage(1).single.id, first!.id);
    });
  });

  test('undo walks back through several changes', () async {
    final controller = await loaded(MemoryReaderRepository());
    addTearDown(controller.dispose);

    expect(controller.canUndo, isFalse);

    controller.addStroke(page: 1, stroke: stroke);
    controller.addNote(
      page: 1,
      anchor: const NormPoint(0.5, 0.5),
      body: 'a thought',
    );
    expect(controller.count, 2);

    controller.undo();
    expect(controller.count, 1);
    controller.undo();
    expect(controller.count, 0);
    expect(controller.canUndo, isFalse);
  });

  test('a stroke that is only a dot is not committed', () async {
    final controller = await loaded(MemoryReaderRepository());
    addTearDown(controller.dispose);

    final committed = controller.addStroke(
      page: 1,
      stroke: const InkStroke(
        points: [NormPoint(0.5, 0.5)],
        colorIndex: 4,
        width: 0.004,
      ),
    );

    expect(committed, isNull);
    expect(controller.count, 0);
  });

  group('gesture modes', () {
    test('reading is the default and survives opening the tray', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      expect(controller.viewerMode, ReaderViewerMode.reading);
      expect(controller.isMarkingUp, isFalse);

      controller.openMarkup();
      expect(controller.isMarkingUp, isTrue);
      expect(
        controller.viewerMode,
        ReaderViewerMode.reading,
        reason: 'with no tool chosen, selecting text still highlights',
      );
    });

    test('a drawing tool takes panning, a placing tool does not', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      controller.setTool(ReaderTool.pen);
      expect(controller.viewerMode, ReaderViewerMode.drawing);
      controller.setTool(ReaderTool.eraser);
      expect(controller.viewerMode, ReaderViewerMode.drawing);

      controller.setTool(ReaderTool.note);
      expect(controller.viewerMode, ReaderViewerMode.placing);
      controller.setTool(ReaderTool.text);
      expect(controller.viewerMode, ReaderViewerMode.placing);
    });

    test(
      'moving something puts the page into placing, whatever the tool',
      () async {
        final controller = await loaded(MemoryReaderRepository());
        addTearDown(controller.dispose);

        controller.beginMove('some-id');
        expect(controller.viewerMode, ReaderViewerMode.placing);
        expect(controller.tool, ReaderTool.none);

        controller.endMove();
        expect(controller.viewerMode, ReaderViewerMode.reading);
      },
    );

    test('closing the tray puts every tool away', () async {
      final controller = await loaded(MemoryReaderRepository());
      addTearDown(controller.dispose);

      controller.setTool(ReaderTool.pen);
      controller.beginMove('some-id');
      controller.closeMarkup();

      expect(controller.isMarkingUp, isFalse);
      expect(controller.tool, ReaderTool.none);
      expect(controller.pendingMoveId, isNull);
      expect(controller.viewerMode, ReaderViewerMode.reading);
    });
  });

  test('the pen and the highlighter remember different colours', () async {
    final controller = await loaded(MemoryReaderRepository());
    addTearDown(controller.dispose);

    controller.setTool(ReaderTool.pen);
    controller.setActiveColor(5);
    controller.setTool(ReaderTool.none);
    controller.setActiveColor(2);

    expect(controller.settings.inkColorIndex, 5);
    expect(controller.settings.markupColorIndex, 2);
  });

  test(
    'a fresh highlight takes the remembered colour unless told otherwise',
    () async {
      final repository = MemoryReaderRepository()
        ..settings = const ReaderSettings(markupColorIndex: 3);
      final controller = await loaded(repository);
      addTearDown(controller.dispose);

      final remembered = controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.highlight,
        rects: const [NormRect(0, 0, 1, 0.02)],
        quote: 'a passage',
      );
      final explicit = controller.addTextMarkup(
        page: 1,
        style: ReaderMarkupStyle.underline,
        rects: const [NormRect(0, 0, 1, 0.02)],
        quote: 'another passage',
        colorIndex: 1,
      );

      expect(remembered!.colorIndex, 3);
      expect(explicit!.colorIndex, 1);
    },
  );

  test('writes are debounced, then flushed on demand', () async {
    final repository = MemoryReaderRepository();
    final controller = await loaded(repository);
    addTearDown(controller.dispose);

    controller.addStroke(page: 1, stroke: stroke);
    controller.addStroke(page: 1, stroke: stroke);
    expect(repository.annotationWrites, 0, reason: 'still within the debounce');

    await controller.flush();

    expect(repository.annotationWrites, 1);
    expect(repository.annotations, hasLength(2));
  });

  test('markup made against another build is noticed', () async {
    final repository = MemoryReaderRepository()
      ..annotations = [
        InkAnnotation(
          id: 'i1',
          page: 1,
          revision: 1,
          colorIndex: 4,
          createdAt: DateTime.utc(2026),
          updatedAt: DateTime.utc(2026),
          strokes: const [stroke],
        ),
      ];

    final controller = ReaderAnnotationController(
      repository: repository,
      projectId: 'project-1',
      revision: 2,
    );
    addTearDown(controller.dispose);
    await controller.load();

    expect(controller.needsReanchor, isTrue);

    final result = await controller.reanchor(
      pageCount: 3,
      toRevision: 2,
      loadPage: (_) async => null,
    );

    expect(result?.carried, 1);
    expect(controller.revision, 2);
    expect(controller.needsReanchor, isFalse);
  });

  test('a mark made while the pass runs survives it', () async {
    // The pass works from a snapshot taken before an await that can scan forty
    // pages per stale mark. Replacing the list with its result reverted
    // everything the reader did in between, and the write that follows made the
    // revert durable.
    final repository = MemoryReaderRepository()
      ..annotations = [
        TextMarkupAnnotation(
          id: 'm1',
          page: 1,
          revision: 1,
          colorIndex: 0,
          createdAt: DateTime.utc(2026),
          updatedAt: DateTime.utc(2026),
          style: ReaderMarkupStyle.highlight,
          rects: const [NormRect(0.1, 0.2, 0.3, 0.02)],
          quote: 'The rabbit stretched in the long grass',
        ),
      ];
    final controller = ReaderAnnotationController(
      repository: repository,
      projectId: 'project-1',
      revision: 2,
    );
    addTearDown(controller.dispose);
    await controller.load();

    await controller.reanchor(
      pageCount: 3,
      toRevision: 2,
      loadPage: (page) async {
        // The reader draws while the search is out reading pages.
        controller.addStroke(page: 3, stroke: stroke);
        return _SearchablePage(
          'The rabbit stretched in the long grass and yawned.',
        );
      },
    );

    expect(controller.onPage(3), hasLength(1), reason: 'the new drawing');
    expect(controller.onPage(1), hasLength(1), reason: 'the re-anchored mark');
    expect(repository.annotations, hasLength(2));
  });

  test('leaving the book mid-pass changes nothing', () async {
    final repository = MemoryReaderRepository()
      ..annotations = [
        TextMarkupAnnotation(
          id: 'm1',
          page: 1,
          revision: 1,
          colorIndex: 0,
          createdAt: DateTime.utc(2026),
          updatedAt: DateTime.utc(2026),
          style: ReaderMarkupStyle.highlight,
          rects: const [NormRect(0.1, 0.2, 0.3, 0.02)],
          quote: 'The rabbit stretched in the long grass',
        ),
      ];
    final controller = ReaderAnnotationController(
      repository: repository,
      projectId: 'project-1',
      revision: 2,
    );
    addTearDown(controller.dispose);
    await controller.load();

    final result = await controller.reanchor(
      pageCount: 3,
      toRevision: 2,
      loadPage: (_) async => null,
      isCancelled: () => true,
    );

    expect(result, isNull);
    expect(controller.onPage(1), hasLength(1), reason: 'still on its page');
    expect(
      controller.revision,
      2,
      reason: 'the displayed revision was already this one',
    );
    expect(
      controller.needsReanchor,
      isTrue,
      reason: 'the next open must try again rather than call it done',
    );
    expect(repository.annotationWrites, 0);
  });
}
