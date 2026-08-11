import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';

import 'billing_paywall_harness.dart';

/// A repository whose next verification parks until the gate is completed, so
/// a test can dispose the controller mid-verify.
class GatedBillingRepository extends FakeBillingRepository {
  Completer<void>? verifyGate;

  @override
  Future<GooglePlayVerificationResult> verifyGooglePlayPurchase({
    required String productId,
    required String purchaseToken,
    String? transactionId,
    String? purchaseStatus,
    String? projectId,
  }) async {
    final gate = verifyGate;
    if (gate != null) {
      verifyGate = null;
      await gate.future;
    }
    return super.verifyGooglePlayPurchase(
      productId: productId,
      purchaseToken: purchaseToken,
      transactionId: transactionId,
      purchaseStatus: purchaseStatus,
      projectId: projectId,
    );
  }
}

void main() {
  testWidgets('a purchase landing mid-batch after dispose is still verified',
      (tester) async {
    final store = FakeStoreBillingClient();
    final repository = GatedBillingRepository();
    var elementDisposed = false;
    final controller = BillingController(
      billingRepository: repository,
      storeClient: store,
      onBillingChanged: () {},
      // The real callback is `ref.keepAlive`, which throws once the provider
      // element is disposed — exactly what the controller must survive.
      keepAlive: () {
        if (elementDisposed) {
          throw StateError('keepAlive() called on a disposed element');
        }
        return () {};
      },
    );
    await tester.pump();
    expect(controller.state.loading, isFalse);

    final gate = repository.verifyGate = Completer<void>();
    store.emitAll(const [
      StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'token-1',
      ),
      StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_2',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'token-2',
      ),
    ]);
    // The first purchase is parked inside its verification.
    await tester.pump();

    controller.dispose();
    elementDisposed = true;
    gate.complete();
    await tester.pump();
    await tester.pump();

    // Both purchase tokens reached the backend: the second one's verification
    // must not be skipped because keepAlive threw on a dead element.
    expect(
      repository.verifications.map((call) => call.productId).toList(),
      ['tomeza.credit_pack_1', 'tomeza.credit_pack_2'],
    );
  });
}
