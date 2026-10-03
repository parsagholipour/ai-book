import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';

abstract interface class GoogleSignInClient {
  /// Null means the reader dismissed Google's account chooser.
  Future<String?> authenticate();
}

class NativeGoogleSignInClient implements GoogleSignInClient {
  NativeGoogleSignInClient(this.config);

  final AppConfig config;
  // The SDK singleton must be initialized exactly once, including across
  // provider recreation and signing out of a Tomeza session.
  static Future<void>? _initialization;

  @override
  Future<String?> authenticate() async {
    try {
      final google = GoogleSignIn.instance;
      await (_initialization ??= google.initialize(
        serverClientId: config.googleSignInServerClientId,
        clientId: config.googleSignInIosClientId.isEmpty
            ? null
            : config.googleSignInIosClientId,
      ));
      // Every deliberate sign-in can choose a different account. The app's
      // session is owned by our API; Google is only used to prove identity.
      await google.signOut();
      final account = await google.authenticate();
      final token = account.authentication.idToken;
      if (token == null || token.isEmpty) {
        throw const ApiException(
          code: 'GOOGLE_TOKEN_MISSING',
          message: 'Google could not complete sign-in. Please try again.',
        );
      }
      return token;
    } on GoogleSignInException catch (error) {
      if (error.code == GoogleSignInExceptionCode.canceled) return null;
      throw const ApiException(
        code: 'GOOGLE_SIGN_IN_FAILED',
        message: 'Google sign-in is unavailable. Try again or use email.',
      );
    }
  }
}

final googleSignInClientProvider = Provider<GoogleSignInClient?>((ref) {
  final config = ref.watch(appConfigProvider);
  if (kIsWeb || config.googleSignInServerClientId.isEmpty) return null;
  final supported =
      defaultTargetPlatform == TargetPlatform.android ||
      (defaultTargetPlatform == TargetPlatform.iOS &&
          config.googleSignInIosClientId.isNotEmpty);
  return supported ? NativeGoogleSignInClient(config) : null;
});
