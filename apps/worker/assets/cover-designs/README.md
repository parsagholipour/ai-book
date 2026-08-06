# Cover design artwork

Optional overrides for the bundled cover catalog in
`packages/core/src/generation/coverDesigns.ts`.

Every design draws itself as SVG, so this directory is empty by design and the
catalog needs nothing here to work. It exists for the upgrade path: to replace
one design's generated artwork with real art,

1. put a portrait 3:4 image here (1800×2400 is the render size), and
2. set `artworkFile: "<name>.jpg"` on that entry in the catalog.

Constraints, because this is the artwork *layer* and not the finished cover:

- **No text.** The book's title, subtitle and author are typeset over it by
  `renderCoverPng`, and baked-in lettering would collide with them.
- Keep it dark or mid-toned unless the entry also carries its own `overlayCss` —
  every cover template sets light type.
- Only commit art you have the rights to redistribute. A file that cannot be
  read falls back to the generated SVG rather than failing the book.
