import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/features/auth/presentation/auth_controller.dart';
import 'package:tomeza/features/projects/data/offline_library_store.dart';

import '../app/app_test_fixtures.dart';

// The library kept for being offline belongs to whoever is signed in: an
// offline start opens the account the phone holds, so these files have to be
// that account's. Every way an account leaves the phone empties them.

void main() {
  testWidgets('logging out empties the library kept for being offline', (
    tester,
  ) async {
    final store = MemoryOfflineLibraryStore(
      library: OfflineLibrary(
        books: const [],
        savedAt: DateTime.utc(2026, 10, 12),
      ),
    );
    await tester.pumpWidget(
      testApp(
        authRepository: FakeAuthRepository(initialSession: fakeSession()),
        overrides: [offlineLibraryStoreProvider.overrideWithValue(store)],
      ),
    );
    await tester.pumpAndSettle();
    final epoch = store.epoch;

    final container = ProviderScope.containerOf(
      tester.element(find.byType(TomezaApp)),
    );
    await container.read(authControllerProvider.notifier).logout();
    await tester.pumpAndSettle();

    expect(store.clears, 1);
    expect(store.library, isNull);
    // Anything the old account still had in flight is fenced out.
    expect(store.epoch, greaterThan(epoch));
  });
}
