import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRoot = createRequire(join(workspaceRoot, "package.json"));
const entryArg = process.argv[2];

if (!entryArg) {
  console.error("Usage: node scripts/tsx-dev.mjs <path/to/entry.ts>");
  process.exit(1);
}

function resolvePackageBin(packageName, fallbackRelativeBin) {
  try {
    const packageJsonPath = requireFromRoot.resolve(`${packageName}/package.json`);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const binEntry = packageJson.bin;
    const relativeBin =
      typeof binEntry === "string"
        ? binEntry
        : binEntry && typeof binEntry === "object"
          ? binEntry[packageName] ?? Object.values(binEntry)[0]
          : fallbackRelativeBin;
    return join(dirname(packageJsonPath), relativeBin);
  } catch {
    console.error(
      `${packageName} is not installed. From the repo root run: pnpm install` +
        (process.env.DEV_WATCH_POLLING === "true"
          ? " (in Docker: docker compose run --rm api pnpm install)"
          : "")
    );
    process.exit(1);
  }
}

const nodemonPath = resolvePackageBin("nodemon", "bin/nodemon.js");
const tsxPath = resolvePackageBin("tsx", "dist/cli.mjs");

const appDir = process.cwd();
const entry = resolve(appDir, entryArg);
const watchDirs = [
  join(appDir, "src"),
  join(workspaceRoot, "packages/core/src"),
  join(workspaceRoot, "packages/db/src")
];

const usePolling =
  process.env.DEV_WATCH_POLLING === "true" || process.env.CHOKIDAR_USEPOLLING === "true";

const nodemonArgs = [
  ...(usePolling ? ["--legacy-watch"] : []),
  ...watchDirs.flatMap((dir) => ["--watch", dir]),
  "--ext",
  "ts,json",
  "--signal",
  "SIGTERM",
  "--exec",
  `${process.execPath} ${tsxPath} ${entryArg}`
];

console.log(
  `[dev-watch] ${usePolling ? "polling" : "native"} watch for ${entryArg} (+ core, db)`
);

const child = spawn(process.execPath, [nodemonPath, ...nodemonArgs], {
  cwd: appDir,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "development"
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
