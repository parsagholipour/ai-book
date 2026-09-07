# Flutter character library

The account-level character library: the editor sheet, the profile screen, and the @mention
machinery that binds a description's tokens to other characters.

## Gotchas

- **The description field refuses rather than truncates, so its bound is a ceiling well above the
  cap and a mention scan that stops at it.** `_descriptionMax` is advisory on purpose —
  `MaxLengthEnforcement.none`, a counter that reports and a `_save` that refuses — because a reader
  who pastes too much should see "Too long to save." with their text intact, not lose the tail. The
  cost was second-order: with no bound at all, a large paste left the controller holding it and
  every subsequent keystroke re-entered `_syncDescriptionMentions`, which builds `namesById` over
  the whole library, builds `_proseMentionClaimants`, runs `savedLibraryMentionRanges` over the
  whole text and then `resolveLibraryMentions` over it again — two full sweeps per character typed,
  on the UI isolate. Two bounds, and they answer different halves. `_syncDescriptionMentions`
  short-circuits once the description is over the cap, which is what actually bounds our scans, and
  it is safe because over-cap prose can never travel: `_save` refuses any request that would carry
  a description, so a stale `_attachedMentions` cannot reach the wire. `_respellRenamedMentions()`
  is not in front of that short-circuit any more: it hangs off the `charactersProvider`
  subscription in `initState`, the only thing that can deliver a rename, so it costs
  O(library + links) per delivery instead of per keypress and the rename-follow invariant stays
  unconditional without the short-circuit having to let it through — prose parked past the cap
  follows a rename too. The `LengthLimitingTextInputFormatter` at twenty times the cap is for what the
  short-circuit cannot reach: Flutter's own layout, the platform text channel diff, and any
  grapheme walk, none of which care whether our resolver ran. Twenty times — ~13 printed pages — so
  that anything a reader *meant* as a description hits the refusal with its text whole, and only a
  paste nobody was going to edit down inside a six-line box meets the ceiling.
- **Calling a saved character is the book's call with `projectId: null`, and the two gates in front
  of it are the same gates.** `VoiceRepository` takes a nullable project — null routes the cast
  read to `/api/mobile/voice/characters` and the start to its `/calls`, and sends no `pageIndex`
  because there is no book for one to be in — and `VoiceCallScreen`, `VoiceCallController.dial`
  and `VoiceCharacter.projectId` carry the same null through to the paywall. The way in is
  `callLibraryCharacter` (`presentation/character_call.dart`) from the profile's Call button and
  the library card's menu; it re-reads the library cast on every tap, because the cast carries the
  balance and the price and both move between taps, then hands the server's own entry to
  `launchVoiceCall` (`features/voice/presentation/voice_call_launcher.dart`), which is the balance
  toast and the microphone disclosure the cast sheet also runs. The sheet passes `Navigator.pop` as
  its `leave`; a screen that stays put passes nothing. The profile's spinner covers the cast read
  and nothing after it — `onCastLoaded` is where it stops — because a button spinning under a modal
  dialog, or for the length of a call, is a button that looks stuck.
