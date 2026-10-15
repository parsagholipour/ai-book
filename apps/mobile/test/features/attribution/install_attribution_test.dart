import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/attribution/data/install_attribution_tracker.dart';
import 'package:tomeza/features/attribution/data/install_referrer_source.dart';
import 'package:tomeza/features/attribution/domain/install_attribution.dart';

class FakeReferrerSource implements InstallReferrerSource {
  FakeReferrerSource(this.answers);

  /// Answered in turn; the last one repeats.
  final List<InstallReferrerAnswer> answers;
  var reads = 0;

  @override
  Future<InstallReferrerAnswer> read() async {
    final answer = answers[reads < answers.length ? reads : answers.length - 1];
    reads += 1;
    return answer;
  }
}

const _shareReferrer = 'utm_source=share&utm_content=AbC123xyz789';

void main() {
  group('parseInstallReferrer', () {
    test('reads what a share page puts on its Play link', () {
      final attribution = parseInstallReferrer(_shareReferrer)!;
      expect(attribution.source, 'share');
      expect(attribution.medium, 'none');
      expect(attribution.shareSlug, 'AbC123xyz789');
      expect(attribution.toEventJson(), {
        'name': 'install_attributed',
        'source': 'share',
        'medium': 'none',
        'shareSlug': 'AbC123xyz789',
      });
    });

    test('reads Play\'s own organic install', () {
      final attribution = parseInstallReferrer(
        'utm_source=google-play&utm_medium=organic',
      )!;
      expect(attribution.source, 'google-play');
      expect(attribution.medium, 'organic');
      expect(attribution.shareSlug, isNull);
    });

    test('reads a referrer that arrived encoded twice', () {
      expect(
        parseInstallReferrer(
          'utm_source%3Dshare%26utm_content%3DAbC123xyz789',
        )?.shareSlug,
        'AbC123xyz789',
      );
    });

    test('keeps only the utm fields, normalised, and never the rest', () {
      final attribution = parseInstallReferrer(
        'utm_source=Spring+Sale!&utm_medium=CPC&utm_campaign=${'x' * 80}'
        '&gclid=secret-click-id&utm_term=my+name',
      )!;
      expect(attribution.source, 'spring-sale-');
      expect(attribution.medium, 'cpc');
      expect(attribution.campaign, 'x' * 40);
      expect(
        attribution.toEventJson().values.join(' '),
        isNot(contains('secret')),
      );
    });

    test('a slug is a share\'s only when it looks like one and the source '
        'is a share', () {
      expect(
        parseInstallReferrer(
          'utm_source=share&utm_content=../../etc',
        )?.shareSlug,
        isNull,
      );
      expect(
        parseInstallReferrer(
          'utm_source=newsletter&utm_content=AbC123xyz789',
        )?.shareSlug,
        isNull,
      );
    });

    test('no referrer is no attribution; one with no source is unknown', () {
      expect(parseInstallReferrer(null), isNull);
      expect(parseInstallReferrer('  '), isNull);
      expect(parseInstallReferrer('utm_medium=email')?.source, 'unknown');
      expect(
        parseInstallReferrer('%E0%A4%A')?.source,
        anyOf(isNull, 'unknown'),
      );
    });
  });

  group('InstallAttributionTracker', () {
    late MemoryInstallAttributionStore store;
    late List<InstallAttribution> sent;
    var deliver = true;

    InstallAttributionTracker tracker(FakeReferrerSource source) {
      return InstallAttributionTracker(
        source: source,
        store: store,
        report: (attribution) async {
          sent.add(attribution);
          return deliver;
        },
      );
    }

    setUp(() {
      store = MemoryInstallAttributionStore();
      sent = [];
      deliver = true;
    });

    test('asks Play once per install, across launches', () async {
      final source = FakeReferrerSource([
        const InstallReferrerFound(_shareReferrer),
      ]);
      await tracker(source).resolve();
      final relaunched = await tracker(source).resolve();

      expect(source.reads, 1);
      expect(relaunched.attribution?.shareSlug, 'AbC123xyz789');
    });

    test(
      'an install with no referrer is settled and never asked again',
      () async {
        final source = FakeReferrerSource([const InstallReferrerNone()]);
        await tracker(source).resolve();
        await tracker(source).reportIfNeeded();
        expect(await tracker(source).takeRemixOffer(), isNull);

        expect(source.reads, 1);
        expect(sent, isEmpty);
      },
    );

    test('an unreachable Play service is asked again on a later launch, '
        'three times at most', () async {
      final source = FakeReferrerSource([const InstallReferrerUnavailable()]);
      for (var launch = 0; launch < 5; launch += 1) {
        await tracker(source).resolve();
      }
      expect(source.reads, InstallAttributionTracker.maxAttempts);

      final recovering = FakeReferrerSource([
        const InstallReferrerUnavailable(),
        const InstallReferrerFound(_shareReferrer),
      ]);
      store = MemoryInstallAttributionStore();
      await tracker(recovering).resolve();
      expect(
        (await tracker(recovering).resolve()).attribution?.source,
        'share',
      );
    });

    test(
      'reports the install once, and again only after a failed send',
      () async {
        final source = FakeReferrerSource([
          const InstallReferrerFound(_shareReferrer),
        ]);
        deliver = false;
        await tracker(source).reportIfNeeded();
        deliver = true;
        final current = tracker(source);
        await Future.wait([current.reportIfNeeded(), current.reportIfNeeded()]);
        await tracker(source).reportIfNeeded();

        expect(sent.map((attribution) => attribution.source), [
          'share',
          'share',
        ]);
        expect(store.record?.reported, isTrue);
      },
    );

    test(
      'offers the share\'s remix exactly once, whatever happens next',
      () async {
        final source = FakeReferrerSource([
          const InstallReferrerFound(_shareReferrer),
        ]);
        final first = tracker(source);
        final offers = await Future.wait([
          first.takeRemixOffer(),
          first.takeRemixOffer(),
        ]);
        expect(offers.whereType<String>(), ['AbC123xyz789']);
        expect(await tracker(source).takeRemixOffer(), isNull);
      },
    );

    test('the offer and the report do not undo each other\'s record', () async {
      final source = FakeReferrerSource([
        const InstallReferrerFound(_shareReferrer),
      ]);
      final current = tracker(source);
      await Future.wait([current.reportIfNeeded(), current.takeRemixOffer()]);

      expect(store.record?.reported, isTrue);
      expect(store.record?.remixOffered, isTrue);
    });

    test('the record survives the file store', () async {
      final root = await Directory.systemTemp.createTemp('attribution_test');
      addTearDown(() => root.delete(recursive: true));
      final fileStore = FileInstallAttributionStore(root: root);
      const saved = InstallAttributionRecord(
        attempts: 1,
        settled: true,
        attribution: InstallAttribution(
          source: 'share',
          medium: 'none',
          shareSlug: 'AbC123xyz789',
        ),
        reported: true,
      );
      await fileStore.save(saved);

      final loaded = await FileInstallAttributionStore(root: root).load();
      expect(loaded?.settled, isTrue);
      expect(loaded?.reported, isTrue);
      expect(loaded?.remixOffered, isFalse);
      expect(loaded?.attribution?.shareSlug, 'AbC123xyz789');
    });
  });
}
