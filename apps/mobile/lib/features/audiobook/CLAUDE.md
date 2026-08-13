# Audiobook

Downloading, playing and tracking position through a narrated book. `audiobook_controller.dart`
drives it, `audiobook_player.dart` wraps just_audio, `audiobook_cache.dart` manages the files and
`audiobook_progress_store.dart` the saved place.

Chapter audio is downloaded to `tomeza_audiobook/<projectId>/<audiobookId>/` and played from disk
rather than streamed from a URL, because the media session keeps playing when the app is
backgrounded — where a token refresh cannot be relied on. Lock-screen artwork must be a `file://`
URI for the same reason: the media session fetches it outside the Dio client and without the
bearer token.

## Playback and listening position

- **The app plays local files, not a URL, and draws one timeline over many of them.** Chapter audio
  is downloaded into `tomeza_audiobook/<projectId>/<audiobookId>/` because the media session keeps
  playing when the app is backgrounded, where a token refresh cannot be relied on. Every chapter has
  a length from the moment it is planned — `estimatedDurationMs` until it is narrated,
  `durationMs` after — which is what lets the seek bar show the whole book while the back half is
  still being made. Lock-screen artwork must be a `file://` URI: the media session fetches it
  outside the Dio client and without the bearer token.
- **The listening position is device-local, book-global, and stamped with the narration it belongs
  to.** `AudiobookProgressStore` writes `tomeza_audiobook/<projectId>/progress.json` — beside the
  audio rather than inside one narration's directory, so `pruneOtherAudiobooks` (directories only)
  leaves it and `clearProject` takes it. It stores a position in the *whole book*, never a chapter
  offset, because the chapter a position falls in shifts as later chapters are narrated. The
  `audiobookId` is the reset: `_restorePlace` deletes a position saved against any other narration
  instead of using it, since re-narrating replaces the audio and the old number would land somewhere
  plausible and wrong — `narrate()` also clears it outright. It is saved every 5s while playing and
  forced on pause and teardown, because the ordinary end of a session is the OS killing a
  backgrounded app, where nothing gets to run. Restoring is *silent and deferred*: chapters download
  in book order, so `_applyResumeIfReady` waits for the one holding the position and seeks then —
  and `togglePlay`/`seekGlobal` drop the pending resume, because a play button that moves you
  somewhere else a moment later is worse than not resuming at all. `narrate()` must also
  `_resetPlayback()`: the queue is read positionally against the manifest, so appending a new
  narration's chapters to the old queue plays the wrong chapter rather than failing.
- **just_audio's `playing` means the play button is engaged, not that sound is coming out.** It
  stays true when the queue reaches the end of the chapters that exist, so `AudiobookPlayer.playing`
  and `playingStream` fold `ProcessingState.completed` back out — that derived value is what the
  play button renders. Papering over it in the controller instead (forcing `playing: false` when
  `completedStream` fires) desynchronises the two: seeking back into narrated audio resumes the
  player on its own, and because its own `playing` never changed it has nothing to announce, so the
  button sits on Play over audible narration. For the same reason Play cannot mean `play()` when
  the queue has finished — that is a no-op on silence — so `togglePlay` moves to the next chapter
  that has been downloaded since, and `caughtUp` says why playback stopped where it did.
