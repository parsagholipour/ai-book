import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/ui/polling_state_mixin.dart';

void main() {
  testWidgets('startPolling is idempotent while a loop is active', (
    tester,
  ) async {
    final key = GlobalKey<_PollingHarnessState>();
    var firstCallbacks = 0;
    var replacementCallbacks = 0;
    await tester.pumpWidget(_PollingHarness(key: key));

    key.currentState!.startPolling(
      const Duration(seconds: 1),
      () => firstCallbacks += 1,
    );
    key.currentState!.startPolling(
      const Duration(milliseconds: 100),
      () => replacementCallbacks += 1,
    );

    expect(key.currentState!.isPolling, isTrue);
    await tester.pump(const Duration(seconds: 1));
    expect(firstCallbacks, 1);
    expect(replacementCallbacks, 0);
  });

  testWidgets('stopPolling allows the loop to restart', (tester) async {
    final key = GlobalKey<_PollingHarnessState>();
    var callbacks = 0;
    await tester.pumpWidget(_PollingHarness(key: key));

    key.currentState!.startPolling(
      const Duration(seconds: 1),
      () => callbacks += 1,
    );
    await tester.pump(const Duration(seconds: 1));
    expect(callbacks, 1);

    key.currentState!.stopPolling();
    expect(key.currentState!.isPolling, isFalse);
    await tester.pump(const Duration(seconds: 2));
    expect(callbacks, 1);

    key.currentState!.startPolling(
      const Duration(milliseconds: 500),
      () => callbacks += 1,
    );
    await tester.pump(const Duration(milliseconds: 500));
    expect(callbacks, 2);
    expect(key.currentState!.isPolling, isTrue);
  });

  testWidgets('dispose cancels polling before another callback can run', (
    tester,
  ) async {
    final key = GlobalKey<_PollingHarnessState>();
    var callbacks = 0;
    await tester.pumpWidget(_PollingHarness(key: key));
    final state = key.currentState!;
    state.startPolling(const Duration(seconds: 1), () => callbacks += 1);

    await tester.pumpWidget(const SizedBox.shrink());
    expect(state.isPolling, isFalse);
    await tester.pump(const Duration(seconds: 2));
    expect(callbacks, 0);
  });
}

class _PollingHarness extends StatefulWidget {
  const _PollingHarness({super.key});

  @override
  State<_PollingHarness> createState() => _PollingHarnessState();
}

class _PollingHarnessState extends State<_PollingHarness>
    with PollingStateMixin<_PollingHarness> {
  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
