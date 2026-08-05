#!/usr/bin/env node
/**
 * Fails when a source file grows past the point where it is comfortable to work
 * on — for a person or for an AI assistant that has to load it to change one
 * line. This repo previously had three files over 6,000 lines; this guard keeps
 * them from coming back.
 *
 * When you hit the limit, split the file along a real seam (a job handler, a
 * route group, a widget cluster) rather than raising the number.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const LIMITS = {
  ".ts": 900,
  ".tsx": 900,
  ".dart": 900
};

const SEARCH_ROOTS = ["apps/api/src", "apps/worker/src", "apps/web/src", "packages/core/src", "packages/db/src", "apps/mobile/lib", "apps/mobile/test"];

/** Generated or vendored code we do not own. */
const SKIP_DIRS = new Set(["node_modules", "generated", "dist", "build", ".dart_tool"]);

/**
 * Files that are over budget today and are not worth splitting yet. Each entry
 * is a ceiling, not a blessing: shrink it when you touch the file, and never
 * raise one without splitting something first.
 */
const GRANDFATHERED = {
  "packages/core/src/generation/pages.ts": 2450,
  "packages/core/src/generation/pages.test.ts": 2160,
  "apps/api/src/routes/projects.ts": 1990,
  "apps/api/src/mobileCreation.ts": 2590,
  "apps/web/src/features/voice/BrowserVoiceRoomClient.ts": 1790,
  "apps/web/src/features/voice/BrowserVoiceCallClient.ts": 1360,
  "apps/api/src/routes/projects.test.ts": 1200,
  "apps/api/src/mobileCreation.test.ts": 1200,
  "packages/core/src/voiceConversations.ts": 1040,
  "apps/api/src/mobile/bookEditIntents.ts": 1080,
  "apps/mobile/lib/features/projects/presentation/creation_chat_screen.dart": 1540,
  "apps/mobile/lib/features/projects/presentation/creation_chat_controller.dart": 1500,
  "apps/mobile/test/projects/creation_chat_test.dart": 3470
};

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walk(join(dir, entry.name));
      }
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

const violations = [];
const staleAllowances = [];

for (const searchRoot of SEARCH_ROOTS) {
  const absolute = join(ROOT, searchRoot);
  try {
    statSync(absolute);
  } catch {
    continue;
  }
  for (const file of walk(absolute)) {
    const extension = file.slice(file.lastIndexOf("."));
    const limit = LIMITS[extension];
    if (limit === undefined) {
      continue;
    }
    const key = relative(ROOT, file).split(sep).join("/");
    const lines = readFileSync(file, "utf8").split("\n").length;
    const allowance = GRANDFATHERED[key];
    const effectiveLimit = allowance ?? limit;
    if (lines > effectiveLimit) {
      violations.push({ key, lines, limit: effectiveLimit, grandfathered: allowance !== undefined });
    } else if (allowance !== undefined && lines <= limit) {
      staleAllowances.push(key);
    }
  }
}

for (const stale of staleAllowances) {
  console.log(`note: ${stale} is now under the default limit — drop its GRANDFATHERED entry.`);
}

if (violations.length > 0) {
  console.error("\nFile size budget exceeded:\n");
  for (const violation of violations.sort((a, b) => b.lines - a.lines)) {
    const kind = violation.grandfathered ? "grew past its recorded ceiling" : "is over the default limit";
    console.error(`  ${violation.key}: ${violation.lines} lines (${kind} of ${violation.limit})`);
  }
  console.error("\nSplit the file along a real seam instead of raising the limit.\n");
  process.exit(1);
}

console.log("File size budget OK.");
