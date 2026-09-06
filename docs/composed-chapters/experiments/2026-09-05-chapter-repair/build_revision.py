#!/usr/bin/env python3
"""Build revised.md from source-blocks.json and edit-plan.json.

Standard library only. Deterministic: the same inputs produce byte-identical
revised.md and provenance.json.

Rules:
  * operations are processed in the order they appear in edit-plan.json;
  * `copy` emits the exact text of its single source block;
  * `replace` emits the exact supplied `text`, byte for byte;
  * outputs are joined with two newlines and the file ends with one newline;
  * before anything is written the build rejects a missing or duplicate
    operation id, a referenced source id that does not exist, an unknown
    operation kind, a `replace` without a string `text`, and a `copy` that
    does not name exactly one source block.

"Original" in provenance.json means every source block in file order, joined
with the same two-newline rule and one trailing newline. Word counts are
whitespace-separated tokens (str.split()). Hashes are SHA-256 over UTF-8 bytes.
"""

import hashlib
import json
import sys
from collections import OrderedDict
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE_PATH = HERE / "source-blocks.json"
PLAN_PATH = HERE / "edit-plan.json"
REVISED_PATH = HERE / "revised.md"
PROVENANCE_PATH = HERE / "provenance.json"

SEPARATOR = "\n\n"
TRAILER = "\n"


class BuildError(Exception):
    pass


def load_json(path):
    def reject_duplicate_keys(pairs):
        seen = set()
        for key, _ in pairs:
            if key in seen:
                raise BuildError(f"{path.name}: duplicate key {key!r}")
            seen.add(key)
        return OrderedDict(pairs)

    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh, object_pairs_hook=reject_duplicate_keys)


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def word_count(text):
    return len(text.split())


def validate(source_blocks, plan):
    if not isinstance(source_blocks, dict):
        raise BuildError("source-blocks.json: top level must be an object")
    operations = plan.get("operations") if isinstance(plan, dict) else None
    if not isinstance(operations, list):
        raise BuildError("edit-plan.json: 'operations' must be a list")

    errors = []
    for sid, text in source_blocks.items():
        if not isinstance(text, str):
            errors.append(f"source block {sid!r}: value is not a string")

    seen_ids = set()
    for index, op in enumerate(operations):
        label = f"operation #{index}"
        if not isinstance(op, dict):
            errors.append(f"{label}: not an object")
            continue
        op_id = op.get("id")
        if not isinstance(op_id, str) or not op_id:
            errors.append(f"{label}: missing id")
        elif op_id in seen_ids:
            errors.append(f"{label}: duplicate id {op_id!r}")
        else:
            seen_ids.add(op_id)
            label = f"operation {op_id!r}"

        refs = op.get("sourceBlocks")
        if not isinstance(refs, list) or not refs:
            errors.append(f"{label}: sourceBlocks must be a non-empty list")
            refs = []
        for ref in refs:
            if not isinstance(ref, str) or ref not in source_blocks:
                errors.append(f"{label}: references missing source block {ref!r}")

        kind = op.get("operation")
        if kind == "copy":
            if len(refs) != 1:
                errors.append(f"{label}: copy must name exactly one source block")
        elif kind == "replace":
            if not isinstance(op.get("text"), str):
                errors.append(f"{label}: replace requires a string 'text'")
        else:
            errors.append(f"{label}: unknown operation {kind!r}")

    if errors:
        raise BuildError("\n".join(errors))
    return operations


def emit(source_blocks, operations):
    outputs = []
    for op in operations:
        if op["operation"] == "copy":
            outputs.append(source_blocks[op["sourceBlocks"][0]])
        else:
            outputs.append(op["text"])
    return outputs


def main():
    try:
        source_blocks = load_json(SOURCE_PATH)
        plan = load_json(PLAN_PATH)
        operations = validate(source_blocks, plan)
    except (OSError, ValueError, BuildError) as exc:
        print(f"build_revision: rejected, nothing written:\n{exc}", file=sys.stderr)
        return 1

    outputs = emit(source_blocks, operations)
    revised = SEPARATOR.join(outputs) + TRAILER
    original = SEPARATOR.join(source_blocks.values()) + TRAILER

    emitted_texts = set(outputs)
    not_unchanged = [sid for sid, text in source_blocks.items() if text not in emitted_texts]
    referenced = {ref for op in operations for ref in op["sourceBlocks"]}
    replaced_or_merged = [sid for sid in not_unchanged if sid in referenced]
    dropped = [sid for sid in not_unchanged if sid not in referenced]

    provenance = OrderedDict(
        [
            ("builder", "build_revision.py"),
            ("inputs", OrderedDict([
                ("source-blocks.json", sha256_file(SOURCE_PATH)),
                ("edit-plan.json", sha256_file(PLAN_PATH)),
            ])),
            ("operations", operations),
            ("emittedBlockCount", len(outputs)),
            ("sourceBlocksNotEmittedUnchanged", not_unchanged),
            ("sourceBlocksNotEmittedUnchangedBreakdown", OrderedDict([
                ("replacedOrMerged", replaced_or_merged),
                ("dropped", dropped),
            ])),
            ("wordCounts", OrderedDict([
                ("original", word_count(original)),
                ("revised", word_count(revised)),
            ])),
            ("sha256", OrderedDict([
                ("original", sha256_text(original)),
                ("revised", sha256_text(revised)),
            ])),
            ("definitions", OrderedDict([
                ("original", "all source blocks in file order, joined with two newlines, one trailing newline"),
                ("wordCount", "len(text.split())"),
                ("sha256", "over UTF-8 bytes; 'revised' matches the bytes written to revised.md"),
            ])),
        ]
    )

    REVISED_PATH.write_bytes(revised.encode("utf-8"))
    PROVENANCE_PATH.write_bytes(
        (json.dumps(provenance, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    )

    print(
        f"wrote {REVISED_PATH.name} ({len(outputs)} blocks, "
        f"{provenance['wordCounts']['revised']} words, "
        f"sha256 {provenance['sha256']['revised'][:12]}...) and {PROVENANCE_PATH.name}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
