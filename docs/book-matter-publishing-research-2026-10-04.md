# Book matter audit — 2026-10-04

The export has the main reading content, but lacks much of the surrounding material readers associate with a published book. Prioritize a separate interior title page, publication/copyright and credits page, author biography, and working dedication support. Offer additional matter by book type rather than adding every possible page to every book.

## Current app behavior

This is a source-code audit and comparison with publisher documentation/samples. A direct `compileBookMarkdownWithPageAnchors` probe used a named author and two-chapter, eight-page fixture in SCIENCE and BUSINESS, with and without a cover: SCIENCE emitted cover/contents/chapters/sources with a cover, or title/contents/chapters/sources without one; BUSINESS followed the same pattern without Sources even when research was supplied. No new book generation or PDF/EPUB rendering was performed.

| Component | Current behavior | Evidence |
| --- | --- | --- |
| Cover and interior title page | The compiler uses a cover **or** a fallback title page. A cover suppresses the interior title page; the fallback also requires an author name. | `packages/core/src/generation/markdown.ts:223–269`, `:546` |
| Contents | Conditional contents support exists. | `packages/core/src/generation/markdown.ts:223–269` |
| Copyright/publication details, credits, author biography, acknowledgments | No dedicated fields in the compile input or dedicated matter rendering in the audited path. Ordinary body text could contain these headings, but that is not structural support. | `CompileMarkdownInput`, `packages/core/src/generation/markdown.ts:30–86` |
| Dedication | Writing Studio accepts and stores a dedication, but the worker does not pass it into compilation and the core has no dedication renderer. | `apps/api/src/mobile/manuscript/manuscriptProjects.ts:195–207`; `apps/worker/src/handlers/compileExport.ts:690–720` |
| Sources | Dedicated back matter exists as a title-and-URL list. Defaults enable it for SCIENCE, HEALTH, BIOGRAPHY and HISTORY, not BUSINESS, EDUCATION or SELF_HELP. This is not a complete citation/notes apparatus. | `packages/core/src/generation/markdown.ts:807` onward; `BackMatterEdit` supports `includeSources` |

## Publishing baseline: conventions versus requirements

KDP describes many front/back matter elements as optional and recommends comparing books with similar content. Its paperback guidance places the interior title before the copyright page and lists references, author biography and index as possible back matter. These are useful publishing conventions, not a universal checklist or a legal conclusion about what every book must contain. [KDP paperback matter](https://kdp.amazon.com/en_US/help/topic/GDDYZG2C7RVF5N9J)

For a conventional English-language paperback, a practical example order is: optional half-title → interior title → copyright/publication details and compact credits → optional dedication/epigraph → contents where useful → optional preface/introduction → main text → optional acknowledgments → relevant reference material → author biography. Omit sections that have no content. Acknowledgments and author information can appear elsewhere, as the real samples below demonstrate. This proposed default is a synthesis, not a mandated order. [KDP paperback matter](https://kdp.amazon.com/en_US/help/topic/GDDYZG2C7RVF5N9J)

| Matter | Purpose and priority |
| --- | --- |
| Interior title | High priority: title, subtitle and author identity inside the book, even when there is a cover. Add contributor/imprint details when supplied. KDP explicitly recommends a title page for ebooks. [KDP ebook guide](https://kdp.amazon.com/en_US/help/topic/G200910130) |
| Copyright/publication details | High priority: a place for supplied rights notice, publisher/imprint, edition/publication year and applicable ISBN. Kindle Create treats copyright, edition and publisher information together. [Kindle Create](https://kdp.amazon.com/en_US/help/topic/G7R2L7V5X6SJH948) |
| Credits | High priority capability: author, illustrator, translator, editor and design roles when applicable, plus image/quotation attributions. A separate full page is optional; credits can sit on the copyright page or beside the relevant material. [Chicago rights guidance](https://press.uchicago.edu/resource/rights.html) |
| About the author | High priority optional section: a supplied biography, with portrait/links if wanted. KDP lists author information as possible ebook back matter. [KDP ebook guide](https://kdp.amazon.com/en_US/help/topic/G200910130) |
| Dedication and acknowledgments | Dedication honors someone; acknowledgments thank contributors/supporters. Both are optional. Implement the existing dedication promise, then offer acknowledgments. [Kindle Create](https://kdp.amazon.com/en_US/help/topic/G7R2L7V5X6SJH948) |
| Preface, foreword, introduction | Conditional: author context, another contributor's introduction, or orientation to the subject. Prologues/epilogues instead serve the story. Do not mechanically prepend all of them. [Kindle Create](https://kdp.amazon.com/en_US/help/topic/G7R2L7V5X6SJH948) |
| Notes and references | Important for research-led nonfiction: connect claims to identifiable sources, using consistent citations. Chicago distinguishes notes-plus-bibliography from author-date-plus-reference-list; a wider further-reading list has a different purpose. [Chicago manuscript guidance](https://press.uchicago.edu/resource/emsguide.html) |
| Glossary, appendices, lists of figures/tables, contributor list, index | Conditional reader aids for technical, educational, scholarly or multi-contributor works. Select according to actual content. [Chicago manuscript guidance](https://press.uchicago.edu/resource/emsguide.html); [Cambridge nonfiction example](https://assets.cambridge.org/97805216/62277/frontmatter/9780521662277_frontmatter.htm) |
| Also by / books in series | Optional discovery pages, populated only from the author's actual catalogue. [Kindle Create](https://kdp.amazon.com/en_US/help/topic/G7R2L7V5X6SJH948) |

## Differences by book and output

- **Novel/story:** recommended default: identity/publication pages, optional dedication, and supplied author biography/acknowledgments. Add story aids only when needed; the literary sample below illustrates a tailored selection. [Penguin/Vintage sample](https://cdn.penguin.co.uk/dam-assets/books/9781529918632/9781529918632-sample.pdf)
- **Nonfiction/reference:** prioritize useful contents, introduction/how-to-use guidance and adequate source documentation. Add glossary, appendices, illustration lists or index only where they help readers retrieve information. An index must match the final output's locations. [Chicago manuscript guidance](https://press.uchicago.edu/resource/emsguide.html); [Cambridge example](https://assets.cambridge.org/97805216/62277/frontmatter/9780521662277_frontmatter.htm)
- **Illustrated books:** contributor and image attribution support matters. A compact copyright/credits page may be sufficient; reader aids depend on the book. Chicago places figure credits in captions and table credits below tables, while Penguin's sample below consolidates illustration/design credits on the publication page. [Chicago manuscript guidance](https://press.uchicago.edu/resource/emsguide.html); [Penguin illustrated sample](https://cdn.penguin.co.uk/dam-assets/books/9780141996325/9780141996325-sample.pdf)
- **Print:** page-side rules, blank versos, running heads and numbering are layout concerns beyond adding content. KDP's English paperback example uses a right-facing title and a following left-facing copyright page. Its conventions should not be blindly applied to this app's right-to-left books. [KDP paperback matter](https://kdp.amazon.com/en_US/help/topic/GDDYZG2C7RVF5N9J)
- **EPUB:** navigation is distinct from a visible contents page. KDP requires a logical TOC and strongly recommends a visible HTML TOC. Reflowable navigation should link to sections, not depend on fixed print page numbers. Apple Books computes displayed locations for font/screen size and requires TOC navigation. [KDP navigation](https://kdp.amazon.com/en_US/help/topic/G201605710); [Apple Books Asset Guide](https://help.apple.com/itc/booksassetguide/en.lproj/static.html)
- **Print cover package:** a front-cover image does not constitute a complete physical cover. IngramSpark requires a separate interior PDF and an exterior PDF combining front, spine and back, with flaps when applicable. Back-cover description, author information and barcode belong to that exterior workflow. [IngramSpark files](https://www.ingramspark.com/blog/file-requirements-for-print-books); [cover guidance](https://www.ingramspark.com/master-your-book-cover-design)

## Actual publisher-hosted comparisons

**The Last Dream — Pedro Almodóvar, translated by Frank Wynne, Vintage 2025.** The publisher's sample contains author/translator biographies, an interior title page with translator credit, a copyright/publication page, dedication, epigraph, contents and introduction before the stories. The contents explicitly lists a translator's note at page 213, author information at 215 and credits at 217. These final pages are listed, not themselves included in the sample. This is direct evidence that author and credits sections are normal possibilities even for a literary collection. [Penguin/Vintage sample, PDF pages 2–10](https://cdn.penguin.co.uk/dam-assets/books/9781529918632/9781529918632-sample.pdf)

**Math Without Numbers — Milo Beckman, illustrated by M Erazo, Penguin 2022.** Its sample has praise and author biography, a separate interior title that credits the illustrator, a publication/copyright page naming illustration and book-design roles, a dedication with brief thanks, and contents. Credits need not consume a separate page, and the author biography need not be at the end. [Penguin sample, PDF pages 2–10](https://cdn.penguin.co.uk/dam-assets/books/9780141996325/9780141996325-sample.pdf)

For a denser nonfiction comparison, Cambridge's published contents for **A History of the English Language** includes figure/table/contributor lists, preface and acknowledgments before the chapters, then further reading, references and index. That supports genre-specific reference matter rather than adding an index to every generated story. [Cambridge front matter](https://assets.cambridge.org/97805216/62277/frontmatter/9780521662277_frontmatter.htm)

## Recommended scope

1. Add structured, editable book matter shared by generated books and Writing Studio: independent title page, publication/credits, dedication, acknowledgments and author biography. Render configured sections consistently in PDF and EPUB.
2. Preserve factual provenance: obtain names, biographies, contributor roles, imprint, rights text and edition identifiers from the user or trusted project metadata. Do not generate invented credentials, endorsements, publishers, ISBNs or permissions claims.
3. Make nonfiction references and optional glossary/appendix/index support a separate content-aware capability. An automatically collected source URL list does not prove which claims it supports.
4. Apply output-specific layout and navigation, then verify representative short illustrated, long fiction, nonfiction and right-to-left exports.

An optional reader-facing creation note could explain AI use, but it is a product decision. KDP's stated requirement is to disclose AI-generated text/images/translations **to KDP during publication**; that should not be described as a universal mandatory printed AI credits page. [KDP content policy](https://kdp.amazon.com/en_US/help/topic/G200672390)
