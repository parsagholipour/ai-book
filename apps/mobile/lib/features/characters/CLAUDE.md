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
