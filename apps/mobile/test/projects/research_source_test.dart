import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/creation_message_models.dart';

void main() {
  group('MobileCreationResearchSource.displayHost', () {
    test('names the publisher, without the www prefix', () {
      const source = MobileCreationResearchSource(
        title: 'Audubon',
        summary: 'Owls hunt at night.',
        url: 'https://www.audubon.org/news/owls',
      );

      expect(source.displayHost, 'audubon.org');
    });

    test('names nobody for a Google grounding redirect', () {
      const source = MobileCreationResearchSource(
        title: 'audubon.org',
        summary: 'Owls hunt at night.',
        url:
            'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123',
      );

      expect(source.displayHost, isNull);
      expect(source.uri, isNotNull);
    });

    test('names nobody when there is no usable link', () {
      const withoutUrl = MobileCreationResearchSource(
        title: 'Planner note',
        summary: 'No link at all.',
      );
      const notWeb = MobileCreationResearchSource(
        title: 'Planner note',
        summary: 'Not a web link.',
        url: 'mailto:someone@example.com',
      );

      expect(withoutUrl.displayHost, isNull);
      expect(notWeb.displayHost, isNull);
    });
  });
}
