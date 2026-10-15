# Audiobook

Downloading, playing and tracking position through a narrated book. `audiobook_controller.dart`
drives it, `audiobook_player.dart` wraps just_audio, `audiobook_cache.dart` manages the files and
`audiobook_progress_store.dart` the saved place.

Chapter audio is downloaded to `tomeza_audiobook/<projectId>/<audiobookId>/` and played from disk
rather than streamed from a URL, because the media session keeps playing when the app is
backgrounded — where a token refresh cannot be relied on. Lock-screen artwork must be a `file://`
URI for the same reason: the media session fetches it outside the Dio client and without the
bearer token.

## Starting a narration

- **Narrating is a plan perk; listening is not.** `audiobooksLockedByPlan`
  (`audiobook_plan_offer.dart`) turns every narrator-picker door (`_openPicker`) into the plans for
  a known free account, and the not-narrated page shows the plan sentence with a lock; a narration
  that already exists always plays, and the quote, fetch and narrator samples stay open to everyone.
  The server refuses the start itself with 403 `SUBSCRIPTION_REQUIRED` ("Audiobooks are part of the
  Creator plan.", `apps/api/src/mobile/planPerks.ts`), whose sentence the picker shows verbatim if
  billing was stale; an older build shows the same sentence as a snackbar.

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
- **Offline, the chapters on this phone play, in order, and nothing is downloaded.** Every manifest
  the server sends is kept as sent beside the narrations (`AudiobookCache.saveManifest`,
  `tomeza_audiobook/<projectId>/manifest.json`, next to `progress.json`: `pruneOtherAudiobooks`
  keeps it, `clearProject` takes it). When a fetch fails with `isOfflineFailure` the controller
  goes offline (`AudiobookState.offline`) with the narration it already had or the kept manifest —
  with neither, the failure is reported as before, never as an offer to narrate — and
  `_syncDownloads` queues only chapters whose audio and timings are already on disk
  (`storedChapter`, the same files and size check the downloads use), stopping at the first that
  is not, because the queue is read positionally. A download that loses the connection mid-way
  goes offline the same way and keeps what is queued playing. Offline it asks the server again
  every 30 s rather than at a narrating book's 4 s; the first answer clears `offline` and the
  remaining chapters download behind what is playing. The listening position is untouched: it is
  device-local already. The screen shows `_OfflineBanner` ("Offline — 2 of 3 chapters on this
  phone") in place of the narration banner — no sparkle, no moving bar, so a manifest kept mid-way
  through narrating is not shown as narrating now — hides Change narrator and the re-narrate
  banner, and says "Not on this phone yet" when nothing of the narration was downloaded.
  `test/audiobook/audiobook_offline_test.dart`.
