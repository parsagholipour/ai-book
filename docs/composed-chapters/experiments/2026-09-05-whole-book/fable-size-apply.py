#!/usr/bin/env python3
"""Move the editor-pass material lines into composedChapterMaterial.ts.

Exact-string edits, each asserted to match exactly once. Both files are
fully rewritten in memory and every assertion passes before either file is
written, so any mismatch leaves the tree untouched.

  1. composedChapterMaterial.ts
     Insert `export function materialEditLines(...)` immediately before
     `export function materialLines`.
  2. composedChapter.ts
     - remove `import { CASE_EVIDENCE_WRITER_RULES } from "./caseEvidence.js";`
     - import list: `  caseReservationLines,` -> `  materialEditLines,`
     - editor systemLines: the CASE_EVIDENCE_WRITER_RULES spread plus the
       caseReservationLines(options) spread -> `...materialEditLines(options),`
"""

from pathlib import Path

ROOT = Path("/run/media/parsa/projects/ravanix-book/ai-book-maker")
GENERATION = ROOT / "packages" / "core" / "src" / "generation"
MATERIAL_PATH = GENERATION / "composedChapterMaterial.ts"
CHAPTER_PATH = GENERATION / "composedChapter.ts"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    """Replace `old` with `new`, asserting `old` occurs exactly once."""
    count = text.count(old)
    assert count == 1, f"{label}: expected exactly 1 occurrence, found {count}:\n{old!r}"
    return text.replace(old, new, 1)


def read(path: Path) -> str:
    assert path.is_file(), f"missing file: {path}"
    # Bytes round-trip so existing line endings are preserved exactly.
    return path.read_bytes().decode("utf-8")


def write(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))


# --- 1. composedChapterMaterial.ts -----------------------------------------

MATERIAL_ANCHOR = "/**\n * Material-first: the writer's lines"

MATERIAL_EDIT_LINES_FN = """\
/**
 * System lines for the editor pass. The editor needs the case evidence rules
 * and case reservations, but not the compose-time opening-scene instructions
 * that materialLines() adds.
 */
export function materialEditLines(options: { material?: ChapterMaterial | undefined }): string[] {
  return [
    ...(options.material?.evidencePackets?.length ? CASE_EVIDENCE_WRITER_RULES : []),
    ...caseReservationLines(options),
  ];
}

"""

# --- 2. composedChapter.ts -------------------------------------------------

CHAPTER_IMPORT_OLD = 'import { CASE_EVIDENCE_WRITER_RULES } from "./caseEvidence.js";\n'
CHAPTER_IMPORT_NEW = ""

# The leading newline anchors the match to the start of a line so the
# import-list entry cannot be confused with a `caseReservationLines(options)` call.
CHAPTER_IMPORT_LIST_OLD = "\n  caseReservationLines,\n"
CHAPTER_IMPORT_LIST_NEW = "\n  materialEditLines,\n"

CHAPTER_SYSTEM_LINES_OLD = (
    "    ...(options.material?.evidencePackets?.length ? CASE_EVIDENCE_WRITER_RULES : []),\n"
    "    ...caseReservationLines(options),\n"
)
CHAPTER_SYSTEM_LINES_NEW = "    ...materialEditLines(options),\n"


def main() -> None:
    material_src = read(MATERIAL_PATH)
    chapter_src = read(CHAPTER_PATH)

    # Preconditions: the new function's references resolve inside the material
    # module, and this script has not already been applied.
    for name in ("ChapterMaterial", "CASE_EVIDENCE_WRITER_RULES", "caseReservationLines"):
        assert name in material_src, f"{MATERIAL_PATH.name}: expected `{name}` to be in scope"
    assert "materialEditLines" not in material_src, (
        f"{MATERIAL_PATH.name}: materialEditLines already exists"
    )
    assert "materialEditLines" not in chapter_src, (
        f"{CHAPTER_PATH.name}: materialEditLines already referenced"
    )

    # Compute both results in full before writing anything.
    material_new = replace_once(
        material_src,
        MATERIAL_ANCHOR,
        MATERIAL_EDIT_LINES_FN + MATERIAL_ANCHOR,
        f"{MATERIAL_PATH.name}: materialLines anchor",
    )

    chapter_new = chapter_src
    chapter_new = replace_once(
        chapter_new,
        CHAPTER_IMPORT_OLD,
        CHAPTER_IMPORT_NEW,
        f"{CHAPTER_PATH.name}: caseEvidence import",
    )
    chapter_new = replace_once(
        chapter_new,
        CHAPTER_IMPORT_LIST_OLD,
        CHAPTER_IMPORT_LIST_NEW,
        f"{CHAPTER_PATH.name}: import-list entry",
    )
    chapter_new = replace_once(
        chapter_new,
        CHAPTER_SYSTEM_LINES_OLD,
        CHAPTER_SYSTEM_LINES_NEW,
        f"{CHAPTER_PATH.name}: editor systemLines",
    )

    # Postconditions: nothing in composedChapter.ts still needs the removed imports.
    assert "CASE_EVIDENCE_WRITER_RULES" not in chapter_new, (
        f"{CHAPTER_PATH.name}: CASE_EVIDENCE_WRITER_RULES still referenced after import removal"
    )
    assert "caseReservationLines" not in chapter_new, (
        f"{CHAPTER_PATH.name}: caseReservationLines still referenced after import swap"
    )
    assert material_new != material_src and chapter_new != chapter_src

    write(MATERIAL_PATH, material_new)
    write(CHAPTER_PATH, chapter_new)

    print(f"updated {MATERIAL_PATH}")
    print(f"updated {CHAPTER_PATH} ({chapter_new.count(chr(10))} lines)")


if __name__ == "__main__":
    main()
