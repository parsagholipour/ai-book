import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/shared/api/api_client.dart';

class _Sent implements Exception {}

/// Records what the verify call would post, then stops: the response is
/// another test's business.
class _RecordingApi implements ApiClient {
  final posts = <({String path, Object? data})>[];

  @override
  Future<Map<String, dynamic>> postMap(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) async {
    posts.add((path: path, data: data));
    throw _Sent();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late _RecordingApi api;
  late MobileBillingRepository repository;

  setUp(() {
    api = _RecordingApi();
    repository = MobileBillingRepository(apiClient: api);
  });

  Future<Map<String, dynamic>> send({
    String? transactionId,
    int? localPriceMicros,
    String? localCurrency,
  }) async {
    await expectLater(
      repository.verifyGooglePlayPurchase(
        productId: 'tomeza.credit_pack_1',
        purchaseToken: 'play-token-1',
        transactionId: transactionId,
        localPriceMicros: localPriceMicros,
        localCurrency: localCurrency,
      ),
      throwsA(isA<_Sent>()),
    );
    expect(api.posts.last.path, '/api/mobile/billing/google-play/verify');
    return api.posts.last.data! as Map<String, dynamic>;
  }

  // Play has no order id yet for a slow card still pending or a promo code,
  // and the plugin hands that over as ''. A server that refused it left the
  // payment unrecorded and unacknowledged, and Play refunded it.
  test('leaves out an order id Play sent blank', () async {
    expect(await send(transactionId: ''), isNot(contains('transactionId')));
    expect(await send(transactionId: '  '), isNot(contains('transactionId')));
    expect(await send(), isNot(contains('transactionId')));
    expect((await send(transactionId: ' GPA.1 '))['transactionId'], 'GPA.1');
  });

  test('sends the buyer\'s own price only whole and well formed', () async {
    expect(
      await send(localPriceMicros: 749000000, localCurrency: 'INR'),
      containsPair('localPriceMicros', 749000000),
    );
    expect(api.posts.last.data, containsPair('localCurrency', 'INR'));
    for (final (micros, currency) in [
      (749000000, null),
      (null, 'INR'),
      (749000000, 'inr'),
      (-1, 'INR'),
    ]) {
      final body = await send(
        localPriceMicros: micros,
        localCurrency: currency,
      );
      expect(
        body,
        isNot(contains('localPriceMicros')),
        reason: '$micros $currency',
      );
      expect(
        body,
        isNot(contains('localCurrency')),
        reason: '$micros $currency',
      );
    }
  });
}
