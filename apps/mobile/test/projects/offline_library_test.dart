import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/offline_library_store.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/shared/api/api_error.dart';

// An offline cold start opened the app with the account the phone holds, but
// the library and each book's download descriptor lived only in memory: every
// book and narration already downloaded was out of reach on a plane. The
// library and each book's last PDF-bearing status are now kept on the phone,
// as the server sent them.

Map<String, dynamic> exportJson(
  String format, {
  bool available = true,
  int revision = 1,
}) => {
  'format': format,
  'available': available,
  'unlocked': true,
  'creditsRequired': 0,
  'downloadUrl': '/api/mobile/projects/p1/export/$format',
  'filename': 'the-race.$format',
  'contentType': format == 'pdf' ? 'application/pdf' : 'application/epub+zip',
  'revision': revision,
  'byteSize': 100 * revision,
};

Map<String, dynamic> summaryJson(
  String id, {
  String title = 'The Race',
  String status = 'complete',
  bool pdf = true,
}) => {
  'id': id,
  'title': title,
  'bookType': 'workbook',
  'lengthPreset': 'short',
  'qualityPreset': 'balanced',
  'status': status,
  'statusLabel': status == 'complete' ? 'Complete' : 'Writing',
  'progressPercent': status == 'complete' ? 100 : 45,
  'currentAction': 'Ready',
  'promptPreview': 'A book',
  'targetPages': 12,
  'pageCount': 12,
  'imageCount': 0,
  'hasPlan': true,
  'exports': {
    'pdf': exportJson('pdf', available: pdf),
    'epub': exportJson('epub', available: false),
  },
  'createdAt': '2026-08-05T00:00:00.000Z',
  'updatedAt': '2026-08-05T00:00:00.000Z',
};

MobileProjectStatus statusFromJson({
  String projectId = 'p1',
  bool pdf = true,
  int revision = 1,
  String status = 'complete',
  String action = 'Your book is ready.',
}) => MobileProjectStatus.fromJson({
  'projectId': projectId,
  'status': status,
  'statusLabel': 'Complete',
  'progressPercent': 100,
  'currentAction': action,
  'steps': const [],
  'pageProgress': {'completed': 12, 'target': 12},
  'imageCount': 0,
  'exports': {
    'pdf': exportJson('pdf', available: pdf, revision: revision),
    'epub': exportJson('epub', available: false),
  },
  'updatedAt': '2026-08-05T00:00:00.000Z',
});

class _ListingRepository implements ProjectsRepository {
  Object? error;
  List<MobileProjectSummary> books = const [];

  @override
  Future<List<MobileProjectSummary>> listProjects() async {
    final failure = error;
    if (failure != null) throw failure;
    return books;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

const _offline = ApiException(
  code: 'NETWORK_ERROR',
  message: 'Check your connection and try again.',
);

void main() {
  group('FileOfflineLibraryStore', () {
    late Directory root;

    setUp(() async {
      root = await Directory.systemTemp.createTemp('offline_library_test');
    });

    tearDown(() async {
      await root.delete(recursive: true);
    });

    test('keeps the library as the server sent it, read back by the same '
        'parser', () async {
      final books = [
        MobileProjectSummary.fromJson(summaryJson('p1')),
        MobileProjectSummary.fromJson(
          summaryJson('p2', title: 'Still going', status: 'generating'),
        ),
      ];
      await FileOfflineLibraryStore(root: root).saveLibrary(books);

      // A fresh store, as on the next cold start.
      final saved = await FileOfflineLibraryStore(root: root).loadLibrary();

      expect(saved, isNotNull);
      expect(saved!.books.map((book) => book.title), [
        'The Race',
        'Still going',
      ]);
      expect(saved.books.first.exports.pdf.available, isTrue);
      expect(saved.books.last.isLive, isTrue);
      expect(
        saved.savedAt.isBefore(DateTime.now().add(const Duration(seconds: 1))),
        isTrue,
      );
    });

    test('a status is kept only while it offers a PDF, and rewritten only '
        'when that PDF changes', () async {
      final store = FileOfflineLibraryStore(root: root);

      await store.saveStatus(statusFromJson(pdf: false));
      expect(await store.loadStatus('p1'), isNull);

      await store.saveStatus(statusFromJson(action: 'first'));
      // Another progress step about the same PDF: not worth a write.
      await store.saveStatus(statusFromJson(action: 'second'));
      var saved = await FileOfflineLibraryStore(root: root).loadStatus('p1');
      expect(saved!.status.currentAction, 'first');
      expect(saved.status.exports.pdf.revision, 1);

      // A new compile is a new descriptor.
      await store.saveStatus(statusFromJson(revision: 2, action: 'third'));
      saved = await FileOfflineLibraryStore(root: root).loadStatus('p1');
      expect(saved!.status.exports.pdf.revision, 2);
      expect(saved.status.currentAction, 'third');

      // A book with no PDF on offer now keeps the one it had: the file on the
      // phone is still that one.
      await store.saveStatus(statusFromJson(pdf: false, revision: 3));
      saved = await store.loadStatus('p1');
      expect(saved!.status.exports.pdf.revision, 2);
    });

    test(
      'a sign-out empties it and fences the writes started before',
      () async {
        final store = FileOfflineLibraryStore(root: root);
        final books = [MobileProjectSummary.fromJson(summaryJson('p1'))];
        await store.saveLibrary(books);
        await store.saveStatus(statusFromJson());

        final before = store.epoch;
        await store.clear();
        expect(await store.loadLibrary(), isNull);
        expect(await store.loadStatus('p1'), isNull);

        // The previous account's request lands after the clear.
        await store.saveLibrary(books, epoch: before);
        await store.saveStatus(statusFromJson(revision: 5), epoch: before);
        expect(await store.loadLibrary(), isNull);
        expect(await store.loadStatus('p1'), isNull);
      },
    );

    test('a deleted book takes its descriptor with it', () async {
      final store = FileOfflineLibraryStore(root: root);
      await store.saveStatus(statusFromJson());
      await store.forgetProject('p1');
      expect(await store.loadStatus('p1'), isNull);
    });

    test('a summary built in code is never written', () async {
      final store = FileOfflineLibraryStore(root: root);
      final saved = MobileProjectSummary.fromJson(summaryJson('p1'));
      await store.saveLibrary([saved]);
      final built = MobileProjectSummary(
        id: 'p2',
        title: 'Built',
        bookType: 'workbook',
        lengthPreset: 'short',
        qualityPreset: 'balanced',
        status: 'complete',
        statusLabel: 'Complete',
        progressPercent: 100,
        currentAction: '',
        promptPreview: '',
        targetPages: 1,
        pageCount: 1,
        imageCount: 0,
        hasPlan: true,
        exports: saved.exports,
        createdAt: DateTime.utc(2026),
        updatedAt: DateTime.utc(2026),
      );
      await store.saveLibrary([saved, built]);
      expect((await store.loadLibrary())!.books.map((book) => book.id), ['p1']);
    });
  });

  group('projectsProvider', () {
    late _ListingRepository repository;
    late MemoryOfflineLibraryStore store;
    late ProviderContainer container;

    setUp(() {
      repository = _ListingRepository();
      store = MemoryOfflineLibraryStore();
      container = ProviderContainer(
        // A failure is the answer under test, not something to wait out.
        retry: (_, _) => null,
        overrides: [
          projectsRepositoryProvider.overrideWithValue(repository),
          offlineLibraryStoreProvider.overrideWithValue(store),
        ],
      );
    });

    tearDown(() => container.dispose());

    test('keeps every list the server sends', () async {
      repository.books = [MobileProjectSummary.fromJson(summaryJson('p1'))];

      final books = await container.read(projectsProvider.future);

      expect(books.single.id, 'p1');
      expect(store.library?.books.single.id, 'p1');
      expect(container.read(offlineLibraryMarkerProvider).savedAt, isNull);
    });

    test('answers with the phone\'s copy when the server is out of reach, '
        'and says so', () async {
      final savedAt = DateTime.utc(2026, 10, 12, 9, 30);
      store.library = OfflineLibrary(
        books: [MobileProjectSummary.fromJson(summaryJson('p1'))],
        savedAt: savedAt,
      );
      repository.error = _offline;

      final books = await container.read(projectsProvider.future);

      expect(books.single.id, 'p1');
      expect(container.read(offlineLibraryMarkerProvider).savedAt, savedAt);
    });

    test('a server that answers with an error is not "offline"', () async {
      store.library = OfflineLibrary(
        books: [MobileProjectSummary.fromJson(summaryJson('p1'))],
        savedAt: DateTime.utc(2026),
      );
      repository.error = const ApiException(
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong.',
        statusCode: 500,
      );

      await expectLater(
        container.read(projectsProvider.future),
        throwsA(isA<ApiException>()),
      );
    });

    test('with nothing kept, being offline is still an error', () async {
      repository.error = _offline;

      await expectLater(
        container.read(projectsProvider.future),
        throwsA(isA<ApiException>()),
      );
    });
  });

  test('only an unreachable server counts as offline', () {
    expect(isOfflineFailure(_offline), isTrue);
    for (final status in [502, 503, 504]) {
      expect(
        isOfflineFailure(
          ApiException(code: 'API_ERROR', message: '', statusCode: status),
        ),
        isTrue,
      );
    }
    expect(
      isOfflineFailure(
        const ApiException(code: 'API_ERROR', message: '', statusCode: 500),
      ),
      isFalse,
    );
    expect(
      isOfflineFailure(
        const ApiException(code: 'NOT_FOUND', message: '', statusCode: 404),
      ),
      isFalse,
    );
    expect(isOfflineFailure(StateError('no')), isFalse);
  });
}
