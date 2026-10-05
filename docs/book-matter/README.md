# Missing book pages and publishing sections

The app generates the main reading content, but it is missing several sections commonly found in published books: an interior title page, publication details, contributor credits, and an author biography. Dedication support exists in Writing Studio settings but does not reach the exported book.

This README summarizes the source-code audit and publishing comparison conducted on October 4, 2026. See the [full research note](../book-matter-publishing-research-2026-10-04.md) for evidence and additional references.

## Structure found in the app

**Cover → Contents, when applicable → Main text → Sources, sometimes**

The export compiler deliberately skips the interior title page whenever a cover exists. A standalone title page appears only for a coverless book with an author name. Without either, the compiler uses a plain title heading.

Sources appear automatically for science, health, biography, and history. Business, education, and self-help books omit Sources by default, even when research links exist. A user preference can override this behavior.

## Missing or incomplete sections

| Page or section | Support found in the audit | Recommended behavior |
| --- | --- | --- |
| Interior title page | Suppressed when a cover exists | Include title, subtitle, author, and relevant contributor names inside the book. |
| Copyright / publication page | No dedicated support | Provide a place for supplied rights text, publication year, edition, publisher or imprint, and ISBN when applicable. |
| Credits | No dedicated support | Credit illustrators, editors, translators, designers, and attributed material. Short credits can share the publication page. |
| About the author | No dedicated support | Offer an optional biography, portrait, and website. The author's name on the cover serves a different purpose. |
| Dedication | Stored in Writing Studio but not rendered into the export | Connect the existing field to a formatted dedication page. |
| Acknowledgments | No dedicated support | Offer optional thanks to people who helped create the book. |
| Notes / bibliography / references | Partial: Sources is a list of titles and links | For researched nonfiction, support consistent citations that connect claims to their sources. |
| Preface / introduction / how to use this book | Could appear as ordinary content; no dedicated treatment | Offer these sections where useful, especially for nonfiction and instructional books. |

Dedicated support means the app can store, position, edit, and render the section consistently. A heading written into ordinary body text does not provide all of those capabilities.

## Comparison with a published book

Penguin's sample of *The Last Dream* by Pedro Almodóvar includes an interior title page, publication page, dedication, epigraph, contents, and introduction. Its contents also lists **About the Author** and **Credits** at the end. Those final pages are listed in the sample's contents rather than reproduced in the sample itself. [Publisher's sample](https://cdn.penguin.co.uk/dam-assets/books/9781529918632/9781529918632-sample.pdf)

These sections are publishing conventions, and many are optional. The appropriate selection depends on the book's content and audience. [KDP's book-structure guide](https://kdp.amazon.com/en_US/help/topic/GDDYZG2C7RVF5N9J)

## Optional sections by book type

| Book type | Useful options |
| --- | --- |
| Fiction | Epigraph, prologue or epilogue, author's note, reading-group questions, and an “Also by” page. |
| Nonfiction | Glossary, appendices, endnotes, further reading, index, and lists of figures or tables. |
| Children's books | Illustrator biography, parent or teacher note, activities, and discussion questions. |
| Print editions | Optional half-title, appropriate blank pages, and a separate back-cover and spine design. |

These are options to select when they serve the reader. They should not all be added automatically. An index must refer to the final export's locations; EPUB navigation should link to sections rather than rely on fixed print page numbers.

## Recommended first implementation

1. Include an interior title page independently of the cover.
2. Add publication details and compact contributor credits.
3. Render the dedication already stored in Writing Studio.
4. Offer optional author biography and acknowledgments sections.
5. Add genre-specific sections and stronger nonfiction references as further capabilities.

A practical default reading order would be:

**Cover → Interior title → Publication details and credits → Optional dedication → Contents, when useful → Optional introduction → Main text → Optional acknowledgments and references → Optional author biography**

Names, biographies, contributor roles, publication details, and rights text should come from the user or trusted project metadata. Generate no invented credentials, endorsements, publishers, ISBNs, or permissions claims.

## Verification and scope

The audit inspected the export compiler, worker compilation path, and Writing Studio dedication settings. A small two-chapter, eight-page compiler example confirmed the cover/title behavior and the difference between science and business Sources defaults.

The audit did not generate a new full book or render PDF/EPUB files. It made no implementation changes.
