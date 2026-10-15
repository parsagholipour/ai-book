import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';

void main() {
  group('AppEnvironment.parse', () {
    test('reads the three environments, in any case and spacing', () {
      expect(AppEnvironment.parse('local'), AppEnvironment.local);
      expect(AppEnvironment.parse(' Staging '), AppEnvironment.staging);
      expect(AppEnvironment.parse('PRODUCTION'), AppEnvironment.production);
    });

    test('a blank value is the build mode default, as an absent define is', () {
      expect(
        AppEnvironment.parse('', releaseBuild: true),
        AppEnvironment.production,
      );
      expect(
        AppEnvironment.parse('  ', releaseBuild: false),
        AppEnvironment.local,
      );
    });

    test('an unknown value fails instead of becoming the emulator host', () {
      for (final releaseBuild in [true, false]) {
        expect(
          () => AppEnvironment.parse('prod', releaseBuild: releaseBuild),
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('"prod"'),
            ),
          ),
        );
      }
      expect(
        () => AppEnvironment.parse('development', releaseBuild: true),
        throwsStateError,
      );
    });
  });
}
