import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';

import '../../../shared/storage/app_files.dart';
import '../domain/audiobook_models.dart';

/// Builds a preview source that satisfies just_audio_background's requirement
/// that every source carry notification/lock-screen metadata.
UriAudioSource narratorPreviewSource(NarratorVoice voice, String filePath) {
  return AudioSource.uri(
    kIsWeb ? Uri.dataFromBytes(appFile(filePath).readAsBytesSync(), mimeType: 'audio/mpeg') : Uri.file(filePath),
    tag: MediaItem(
      id: 'narrator-preview:${voice.voice}',
      title: '${voice.name} preview',
      album: 'Tomeza narrator previews',
      artist: voice.name,
    ),
  );
}
