import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../../shared/api/api_client.dart';
import '../domain/audiobook_models.dart';

/// Where audiobook files live on the device, and how they get there.
///
/// Playback runs off local files rather than a streaming URL for two reasons:
/// the media session keeps playing when the app is backgrounded, where a token
/// refresh cannot be relied on, and a listener who loses signal mid-chapter
/// should not lose the chapter. Everything for one narration sits under its
/// audiobook id, so re-narrating a book with a different voice writes to a new
/// directory and the old one is dropped whole.
class AudiobookCache {
  AudiobookCache({required this.apiClient, Directory? root}) : _override = root;

  final ApiClient apiClient;
  final Directory? _override;
  Directory? _resolved;

  static const directoryName = 'tomeza_audiobook';

  static String safeSegment(String value) {
    final safe = value.replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '-');
    return safe.isEmpty ? 'unknown' : safe;
  }

  Future<Directory> _root() async {
    final override = _override;
    if (override != null) {
      return override;
    }
    return _resolved ??= await getApplicationDocumentsDirectory();
  }

  Future<Directory> audiobookDirectory(
    String projectId,
    String audiobookId,
  ) async {
    final root = await _root();
    final directory = Directory(
      '${root.path}/$directoryName/${safeSegment(projectId)}/${safeSegment(audiobookId)}',
    );
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return directory;
  }

  /// Downloads a narrator preview once and then plays it from local storage.
  ///
  /// The API includes a version in [NarratorVoice.sampleUrl], so replacing a
  /// recording produces a new filename while unchanged samples stay available
  /// across app launches and temporary network loss.
  Future<File> ensureNarratorSample(NarratorVoice voice) async {
    final root = await _root();
    final directory = Directory('${root.path}/$directoryName/samples');
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    final version = Uri.tryParse(voice.sampleUrl)?.queryParameters['v'];
    final cacheKey = version == null || version.isEmpty
        ? safeSegment(voice.voice)
        : '${safeSegment(voice.voice)}-v${safeSegment(version)}';
    final file = File('${directory.path}/$cacheKey.mp3');
    if (await file.exists() && await file.length() > 0) {
      return file;
    }
    await _download(voice.sampleUrl, file);
    return file;
  }

  /// The chapter's audio file, downloading it if this is the first listen.
  ///
  /// Runtime provider fallback can replace a chapter under the same audiobook
  /// id, so the render version in its URL is part of the on-device filename.
  Future<File> ensureChapterAudio({
    required String projectId,
    required String audiobookId,
    required MobileAudiobookChapter chapter,
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
  }) async {
    final url = chapter.audioUrl;
    if (url == null) {
      throw StateError('Chapter ${chapter.index} is not ready to download.');
    }
    final directory = await audiobookDirectory(projectId, audiobookId);
    final version = _renderVersion(url);
    final file = File(
      '${directory.path}/chapter-${chapter.index}-v${safeSegment(version)}.mp3',
    );
    final expected = chapter.byteSize;
    if (await file.exists() &&
        (expected == null || await file.length() == expected)) {
      return file;
    }
    await _download(
      url,
      file,
      onProgress: onProgress,
      cancelToken: cancelToken,
    );
    await _pruneChapterVersions(
      directory: directory,
      chapterIndex: chapter.index,
      keepName: file.path.split(Platform.pathSeparator).last,
      suffix: '.mp3',
    );
    return file;
  }

  Future<AudiobookChapterTimeline> ensureChapterTimeline({
    required String projectId,
    required String audiobookId,
    required MobileAudiobookChapter chapter,
    CancelToken? cancelToken,
  }) async {
    final url = chapter.timelineUrl;
    if (url == null) {
      throw StateError('Chapter ${chapter.index} has no transcript yet.');
    }
    final directory = await audiobookDirectory(projectId, audiobookId);
    final version = _renderVersion(url);
    final file = File(
      '${directory.path}/chapter-${chapter.index}-v${safeSegment(version)}.timeline.json',
    );

    if (!await file.exists()) {
      await _download(url, file, cancelToken: cancelToken);
    }
    try {
      final timeline = AudiobookChapterTimeline.parse(
        await file.readAsString(),
      );
      await _pruneChapterVersions(
        directory: directory,
        chapterIndex: chapter.index,
        keepName: file.path.split(Platform.pathSeparator).last,
        suffix: '.timeline.json',
      );
      return timeline;
    } on FormatException {
      // A truncated write is recoverable: fetch it again rather than leaving
      // the transcript permanently broken for this chapter.
      await file.delete().catchError((_) => file);
      await _download(url, file, cancelToken: cancelToken);
      final timeline = AudiobookChapterTimeline.parse(
        await file.readAsString(),
      );
      await _pruneChapterVersions(
        directory: directory,
        chapterIndex: chapter.index,
        keepName: file.path.split(Platform.pathSeparator).last,
        suffix: '.timeline.json',
      );
      return timeline;
    }
  }

  static String _renderVersion(String url) {
    final version = Uri.tryParse(url)?.queryParameters['v'];
    return version == null || version.isEmpty ? '1' : version;
  }

  Future<void> _pruneChapterVersions({
    required Directory directory,
    required int chapterIndex,
    required String keepName,
    required String suffix,
  }) async {
    final legacyName = 'chapter-$chapterIndex$suffix';
    final versionedPrefix = 'chapter-$chapterIndex-v';
    await for (final entry in directory.list()) {
      if (entry is! File) {
        continue;
      }
      final name = entry.path.split(Platform.pathSeparator).last;
      final isChapterVersion =
          name == legacyName ||
          (name.startsWith(versionedPrefix) && name.endsWith(suffix));
      if (isChapterVersion && name != keepName) {
        await entry.delete().catchError((_) => entry);
      }
    }
  }

  /// Caches cover art as a plain file so the lock screen can show it.
  ///
  /// The media session fetches artwork itself, outside our Dio client and
  /// without the bearer token, so a remote URL would silently render nothing —
  /// it has to be a local file.
  Future<File?> ensureCoverArt({
    required String projectId,
    required String audiobookId,
    required String? coverUrl,
  }) async {
    if (coverUrl == null || coverUrl.isEmpty) {
      return null;
    }
    final directory = await audiobookDirectory(projectId, audiobookId);
    final file = File('${directory.path}/cover.img');
    if (await file.exists()) {
      return file;
    }
    try {
      await _download(coverUrl, file);
      return file;
    } catch (_) {
      // Artwork is decoration. Losing it must never stop playback.
      return null;
    }
  }

  /// Drops every narration for a project except [keepAudiobookId].
  Future<void> pruneOtherAudiobooks(
    String projectId,
    String keepAudiobookId,
  ) async {
    final root = await _root();
    final projectDir = Directory(
      '${root.path}/$directoryName/${safeSegment(projectId)}',
    );
    if (!await projectDir.exists()) {
      return;
    }
    await for (final entry in projectDir.list()) {
      if (entry is Directory &&
          entry.path.split('/').last != safeSegment(keepAudiobookId)) {
        await entry.delete(recursive: true).catchError((_) => entry);
      }
    }
  }

  Future<void> clearProject(String projectId) async {
    final root = await _root();
    final directory = Directory(
      '${root.path}/$directoryName/${safeSegment(projectId)}',
    );
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
  }

  /// Downloads to a `.part` file and renames on success, so an interrupted
  /// download can never be mistaken for a complete one.
  Future<void> _download(
    String url,
    File destination, {
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
  }) async {
    final partial = File('${destination.path}.part');
    if (await partial.exists()) {
      await partial.delete();
    }
    try {
      await apiClient.downloadFile(
        url,
        partial.path,
        onReceiveProgress: onProgress,
        cancelToken: cancelToken,
      );
    } catch (_) {
      if (await partial.exists()) {
        await partial.delete();
      }
      rethrow;
    }
    await partial.rename(destination.path);
  }
}

final audiobookCacheProvider = Provider<AudiobookCache>((ref) {
  return AudiobookCache(apiClient: ref.watch(apiClientProvider));
});
