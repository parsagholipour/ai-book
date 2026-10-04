import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/legal_gate.dart';
import 'package:tomeza/features/auth/presentation/auth_controller.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

import '../app/app_test_fixtures.dart';

void main() {
  for (final failure in [
    DioExceptionType.connectionError,
    DioExceptionType.receiveTimeout,
    DioExceptionType.badResponse,
    null,
  ]) {
    testWidgets(
      'logout returns to sign in after ${failure?.name ?? 'success'}',
      (tester) async {
        final session = fakeSession();
        final tokens = MemoryAuthTokenStore(session.tokens);
        final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
        addTearDown(() => dio.close(force: true));
        RequestOptions? logoutRequest;
        dio.interceptors.add(
          InterceptorsWrapper(
            onRequest: (options, handler) {
              if (options.path == '/api/mobile/auth/me') {
                handler.resolve(
                  Response(
                    requestOptions: options,
                    statusCode: 200,
                    data: {'user': session.user.toJson()},
                  ),
                );
                return;
              }
              logoutRequest = options;
              if (failure != null) {
                handler.reject(
                  DioException(
                    requestOptions: options,
                    type: failure,
                    response: failure == DioExceptionType.badResponse
                        ? Response(requestOptions: options, statusCode: 503)
                        : null,
                  ),
                );
                return;
              }
              handler.resolve(
                Response(
                  requestOptions: options,
                  statusCode: 200,
                  data: {'ok': true},
                ),
              );
            },
          ),
        );
        final repository = MobileAuthRepository(
          apiClient: ApiClient(dio: dio, tokenStore: tokens),
          tokenStore: tokens,
        );
        await tester.pumpWidget(testApp(authRepository: repository));
        await tester.pumpAndSettle();
        final container = ProviderScope.containerOf(
          tester.element(find.byType(TomezaApp)),
        );
        expect(container.read(authControllerProvider).value, isNotNull);
        final previousCache = container.read(creationConversationCacheProvider);
        container.read(legalGateDismissedProvider.notifier).dismiss();

        await tester.runAsync(
          () => container.read(authControllerProvider.notifier).logout(),
        );

        final logoutError = tester.takeException();
        expect(await tokens.read(), isNull);
        expect(container.read(authControllerProvider).isLoading, isFalse);
        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(container.read(authControllerProvider).value, isNull);
        expect(logoutError, isNull);
        expect(container.read(legalGateDismissedProvider), isFalse);
        expect(
          container.read(creationConversationCacheProvider),
          isNot(same(previousCache)),
        );
        expect(logoutRequest?.path, '/api/mobile/auth/logout');
        expect(logoutRequest?.data, {
          'refreshToken': session.tokens.refreshToken,
        });
        await tester.pumpAndSettle();
        expect(find.text('Welcome back'), findsOneWidget);
        expect(find.text('Sign in'), findsOneWidget);
        expect(await repository.restoreSession(), isNull);
      },
    );
  }
}
