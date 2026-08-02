import 'package:flutter_test/flutter_test.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/presentation/narrator_preview_source.dart';

void main() {
  test('narrator previews include the media tag required for playback', () {
    const voice = NarratorVoice(
      voice: 'Zephyr',
      name: 'Zephyr',
      blurb: 'Bright and warm.',
      sampleUrl: '/api/mobile/audiobook/voices/Zephyr/sample?v=1',
    );

    final source = narratorPreviewSource(voice, '/tmp/Zephyr.mp3');
    final tag = source.tag;

    expect(tag, isA<MediaItem>());
    expect((tag as MediaItem).id, 'narrator-preview:Zephyr');
    expect(tag.title, 'Zephyr preview');
    expect(tag.artist, 'Zephyr');
  });
}
