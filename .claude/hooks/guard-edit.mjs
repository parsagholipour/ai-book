#!/usr/bin/env node
/**
 * PreToolUse hook: refuse edits that are guaranteed to be thrown away.
 *
 * `packages/db/src/generated/` is Prisma output and is gitignored. Editing it
 * looks like it works — the types change, the typecheck passes — right up until
 * the next `pnpm db:generate` or a fresh clone, where the change never existed.
 * The fix is always to change `prisma/schema.prisma` and regenerate.
 *
 * Exit 2 blocks the tool call and hands the message to Claude.
 *
 * A hook that throws is worse than no hook, so anything unexpected exits 0.
 */

import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const BLOCKED = [
  {
    prefix: "packages/db/src/generated/",
    reason:
      "packages/db/src/generated/ is Prisma output: gitignored, and overwritten by the next " +
      "`pnpm db:generate`. Edit packages/db/prisma/schema.prisma and regenerate instead — " +
      "an edit here is silently lost on the next generate or a fresh clone."
  }
];

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return 0;
  }

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return 0;

  const abs = isAbsolute(filePath) ? filePath : join(payload?.cwd ?? REPO, filePath);
  const rel = relative(REPO, abs).split("\\").join("/");

  const hit = BLOCKED.find((rule) => rel.startsWith(rule.prefix));
  if (!hit) return 0;

  process.stderr.write(`${hit.reason}\n`);
  return 2;
};

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));
