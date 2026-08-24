#!/usr/bin/env node
/**
 * Two halves of one invariant: a workspace whose container installs it without
 * core's dependencies may only reach core through a module that needs none.
 *
 *   producer side — every narrow subpath export in `packages/core/package.json`
 *   has an EMPTY transitive runtime closure: following only value imports, the
 *   module reaches no other module and no package.
 *
 *   consumer side — every value import of `@book-maker/core` from such a
 *   workspace names one of those subpaths. The barrel is the case that matters:
 *   it is a declared `workspace:*` dependency of `apps/web`, so `import
 *   { jobNames } from "@book-maker/core"` typechecks, bundles and tests green on
 *   the host and 500s in the container at request time.
 *
 * Neither half is worth much alone. The producer side proves the safe imports
 * are safe and says nothing about which imports are actually written; its file
 * list comes off the `exports` map, which by construction never contains `.`, so
 * the one import that breaks the container is the one it cannot see. The
 * consumer side names the offending import and needs the producer side's list to
 * know what it is allowed to name instead. They share that list, the
 * docker-compose read and the definition of a value import, which is why they
 * are one script rather than two.
 *
 * Why a whole gate for this. The web dev container installs `@book-maker/web`
 * alone — `DEV_PNPM_FILTER: "@book-maker/web"` in `docker-compose.yml`, with no
 * `...` suffix, which is 263 packages instead of 437. pnpm still writes the
 * `apps/web/node_modules/@book-maker/core` symlink for a workspace dependency of
 * the selected project, so vite resolves `@book-maker/core/qualityGates` out of
 * the bind-mounted source — but `packages/core/node_modules` inside that
 * container is EMPTY. Nothing core depends on is resolvable there. That works
 * today only because these modules compile down to a file with no import
 * statement left in it.
 *
 * The failure it exists to catch is silent everywhere else: add
 * `import { z } from "zod"` to `qualityGates.ts` — or to anything it reaches —
 * and `pnpm check`, `vite build` on the host and every test still pass, because
 * the host tree has a full install. Only the Docker dev server breaks, at
 * request time, with an unresolvable module. That invariant was stated in prose
 * in `packages/core/CLAUDE.md` and `apps/web/CLAUDE.md` and enforced by nothing.
 *
 * The subpath list is derived from the `exports` map, never hand-written: a
 * fifth entry added later is covered the moment it lands, which is the whole
 * point of not writing this down twice. The consumer list is derived the same
 * way, from `docker-compose.yml`: any service whose `DEV_PNPM_FILTER` has no
 * `...` tail installs that project alone, and the workspace it names is exposed
 * exactly like `apps/web` is. Naming `apps/web` here instead would be the same
 * prose problem one level up.
 *
 * On "value import". A statement is free only when it is erased at build time:
 * statement-level `import type` / `export type`, or a named import whose every
 * specifier is inline `type`. Everything else counts: side-effect imports,
 * `export * from`, `export { x } from`, `import()` and `require()`.
 * String literals and no-substitution template literals resolve normally;
 * computed call specifiers stay fail-closed in a producer closure, where every
 * runtime edge matters. A consumer only rejects a computed expression whose
 * own literal pieces can spell `@book-maker/core` or a relative path into
 * `packages/core/src`; unrelated local and plugin imports are outside this rule.
 *
 * That second form is free only while `verbatimModuleSyntax` is off, and this
 * file used to say so in a comment and assert it nowhere. Turn the option on and
 * `import { type X } from "y"` emits `import {} from "y"`: the statement
 * survives, `y` is resolved at runtime, and `jobSteps.ts` — whose single import
 * is spelled exactly that way — stops being a leaf while this check goes on
 * printing "runtime closure empty". That is the same false green the rest of the
 * file exists to remove, one level up, and flipping the option is a routine
 * modernization for an ESM repo that already writes `.js` specifiers. So the
 * option is READ, from the tsconfig that governs whichever tree is being walked,
 * with `extends` followed nearest-wins; when it is on, an inline-`type` named
 * import counts as surviving and the ordinary closure failure reports it, with a
 * note saying which setting changed the rule. `tsconfig.base.json` also pins it
 * to `false` explicitly, so the dependency is visible at the line someone would
 * edit — the pin is the signpost, this is the enforcement, and neither is worth
 * much alone.
 *
 * Run it alone with `node scripts/check-core-subpaths.mjs`, or as part of the
 * repo gate with `pnpm check --only subpaths`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = process.env.CHECK_CORE_SUBPATHS_ROOT
  ? resolve(process.env.CHECK_CORE_SUBPATHS_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));
const CORE_DIR = join(ROOT, "packages/core");
const CORE_SOURCE_DIR = join(CORE_DIR, "src");
const CORE_MANIFEST = join(CORE_DIR, "package.json");
const COMPOSE = join(ROOT, "docker-compose.yml");
const WORKSPACE_MANIFEST = join(ROOT, "pnpm-workspace.yaml");

/** The bare specifier the `exports` map's keys hang off. */
const CORE_PACKAGE = "@book-maker/core";

/** The barrel is allowed to be as heavy as it likes; every other entry is not. */
const BARREL_KEY = ".";

/** How many closure edges to print before summarising the rest. */
const MAX_REPORTED_EDGES = 12;

/** How many hops of a chain to spell out before eliding the middle. */
const MAX_CHAIN_HOPS = 5;

const rel = (abs) => relative(ROOT, abs).split(sep).join("/");

/** `a → b → c`, with the middle elided once a regression reaches deep enough. */
function formatChain(path) {
  const names = path.map(rel);
  if (names.length <= MAX_CHAIN_HOPS) return names.join(" → ");
  const head = names.slice(0, 2);
  const tail = names.slice(-2);
  return [...head, `… ${names.length - 4} more …`, ...tail].join(" → ");
}

// ---- the one compiler option this file's notion of "free" rests on ----------

/** The tsconfig governing `packages/core`'s own source, i.e. the producer walk. */
const CORE_TSCONFIG = join(CORE_DIR, "tsconfig.json");

/** `./base` and `./base.json` and a directory holding `tsconfig.json` all extend the same file. */
function resolveExtends(fromDir, specifier) {
  const base = resolve(fromDir, specifier);
  if (existsSync(base)) return statSync(base).isDirectory() ? join(base, "tsconfig.json") : base;
  return `${base}.json`;
}

/**
 * `verbatimModuleSyntax`, as it applies to one tree. `extends` is followed
 * nearest-wins, because the option that governs a file is the one nearest it and
 * a package tsconfig is free to override the base — reading only
 * `tsconfig.base.json` would answer for a config that no longer inherits it.
 *
 * The parent search is tri-state: a parent that does not declare or inherit the
 * option cannot hide a declaration in an earlier `extends` entry. Only after the
 * whole effective parent search is exhausted does undeclared become `false`,
 * TypeScript's own default. A config that cannot be *read* is a different thing
 * and is reported, because defaulting to "off" over a file this could not parse
 * is exactly the guess the gate exists to refuse.
 */
function findVerbatimModuleSyntaxDeclaration(tsconfigAbs, ancestors = new Set()) {
  if (ancestors.has(tsconfigAbs)) return { unreadable: `${rel(tsconfigAbs)} — circular "extends" chain` };
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(tsconfigAbs);
  if (!existsSync(tsconfigAbs)) return { unreadable: `${rel(tsconfigAbs)} does not exist` };

  const { config, error } = ts.parseConfigFileTextToJson(tsconfigAbs, readFileSync(tsconfigAbs, "utf8"));
  if (error || !config) return { unreadable: `${rel(tsconfigAbs)} did not parse as tsconfig JSON` };

  const own = config.compilerOptions?.verbatimModuleSyntax;
  if (typeof own === "boolean") return { declared: true, on: own, from: tsconfigAbs };
  if (own !== undefined) {
    return { unreadable: `${rel(tsconfigAbs)} sets "verbatimModuleSyntax" to a non-boolean` };
  }

  // `extends` may be a list, and a later entry wins, so the chain is searched from the back.
  const raw = config.extends;
  const parents = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  for (const parent of [...parents].reverse()) {
    if (typeof parent !== "string") continue;
    if (!parent.startsWith(".")) {
      return {
        unreadable:
          `${rel(tsconfigAbs)} extends "${parent}", a package specifier this check cannot resolve ` +
          "without node resolution"
      };
    }
    const found = findVerbatimModuleSyntaxDeclaration(
      resolveExtends(dirname(tsconfigAbs), parent),
      nextAncestors
    );
    if (found.unreadable !== undefined || found.declared) return found;
  }

  return { declared: false };
}

export function readVerbatimModuleSyntax(tsconfigAbs) {
  const found = findVerbatimModuleSyntaxDeclaration(tsconfigAbs);
  if (found.unreadable !== undefined) return found;
  if (found.declared) return { on: found.on, from: found.from };
  return { on: false, from: null };
}

/** The erasure rule for one tree, carried with enough context to explain itself. */
function erasureFor(tsconfigAbs) {
  const answer = readVerbatimModuleSyntax(tsconfigAbs);
  if (answer.unreadable !== undefined) {
    return { tsconfig: tsconfigAbs, unreadable: answer.unreadable, inlineTypeErased: false, on: null };
  }
  return {
    tsconfig: tsconfigAbs,
    inlineTypeErased: !answer.on,
    on: answer.on,
    declaredIn: answer.from ? rel(answer.from) : null
  };
}

/** Why an `import { type X } from "y"` in this tree is — or is no longer — free. */
function erasureNote(erasure) {
  if (erasure.on !== true) return [];
  const where = erasure.declaredIn
    ? `declared in ${erasure.declaredIn}`
    : "not declared in the extends chain, so this is TypeScript's default";
  return [
    `Note: verbatimModuleSyntax is ON for ${rel(dirname(erasure.tsconfig))} (${where}), which is what`,
    '  changed the rule: `import { type X } from "y"` is no longer erased — it emits',
    '  `import {} from "y"`, so y is resolved at runtime. Statement-level `import type { X }',
    '  from "y"` still is erased. Spelling the import that way is the whole fix.'
  ];
}

// ---- the subpath list, derived from the exports map -------------------------

/**
 * `exports` values are strings today. Conditional-export objects are unwrapped
 * so that adding `{ "types": …, "default": … }` later does not silently drop an
 * entry from the check — a subpath this file cannot read is reported, not
 * skipped.
 */
function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

function readSubpaths() {
  const manifest = JSON.parse(readFileSync(CORE_MANIFEST, "utf8"));
  const map = manifest.exports;
  if (!map || typeof map !== "object") {
    throw new Error(`${rel(CORE_MANIFEST)} has no "exports" map — this check has nothing to derive its list from.`);
  }
  return Object.entries(map)
    .filter(([key]) => key !== BARREL_KEY)
    .map(([key, value]) => ({ key, targets: exportTargets(value) }));
}

/** `./qualityGates` → `@book-maker/core/qualityGates`: what a consumer may write. */
function specifierFor(key) {
  return `${CORE_PACKAGE}${key.slice(BARREL_KEY.length)}`;
}

// ---- what counts as a value import -----------------------------------------

function namedSpecifiersAllTypeOnly(clause) {
  // `import {} from "x"` keeps the statement, so an empty list is not free.
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

/** The inline-`type` form, told apart from the statement-level one it looks like. */
function isInlineTypeOnly(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly || clause.name) return false;
    const bindings = clause.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) return false;
    return namedSpecifiersAllTypeOnly(bindings);
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return false;
    const clause = node.exportClause;
    if (!clause || !ts.isNamedExports(clause)) return false;
    return namedSpecifiersAllTypeOnly(clause);
  }
  return false;
}

function importIsErased(node, inlineTypeErased) {
  const clause = node.importClause;
  if (!clause) return false; // `import "./side-effect.js"`
  if (clause.isTypeOnly) return true; // `import type { X } from …`
  if (clause.name) return false; // default binding
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return false; // `import * as ns`
  return inlineTypeErased && namedSpecifiersAllTypeOnly(bindings);
}

function exportIsErased(node, inlineTypeErased) {
  if (node.isTypeOnly) return true; // `export type { X } from …`
  const clause = node.exportClause;
  if (!clause) return false; // `export * from …`
  if (!ts.isNamedExports(clause)) return false;
  return inlineTypeErased && namedSpecifiersAllTypeOnly(clause);
}

/**
 * `.tsx` has to be parsed as TSX or every `<div>` in the consumer scan comes
 * back as a type assertion. core has no JSX; `apps/web` is nothing but.
 */
function scriptKindOf(absPath) {
  const extension = extname(absPath);
  if (extension === ".tsx" || extension === ".jsx") return ts.ScriptKind.TSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * A bounded approximation of the text a computed import argument can produce.
 * Unknown expressions contribute an empty string, so templates and `+` chains
 * are caught when their own literal pieces can spell a core target. Identifiers
 * are deliberately not followed to their declarations: that would turn every
 * unrelated plugin/local import into an unresolved whole-program data-flow
 * question again.
 */
function staticSpecifierSkeletons(node) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return staticSpecifierSkeletons(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let skeletons = [node.head.text];
    for (const span of node.templateSpans) {
      const substitutions = staticSpecifierSkeletons(span.expression);
      skeletons = skeletons.flatMap((prefix) =>
        substitutions.map((substitution) => `${prefix}${substitution}${span.literal.text}`)
      );
    }
    return skeletons;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return staticSpecifierSkeletons(node.left).flatMap((left) =>
      staticSpecifierSkeletons(node.right).map((right) => `${left}${right}`)
    );
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...staticSpecifierSkeletons(node.whenTrue),
      ...staticSpecifierSkeletons(node.whenFalse)
    ];
  }
  return [""];
}

function computedSpecifierCouldTargetCore(node, fromFile) {
  return staticSpecifierSkeletons(node).some((skeleton) => {
    if (skeleton === CORE_PACKAGE || skeleton.startsWith(`${CORE_PACKAGE}/`)) return true;
    if (!skeleton.startsWith(".")) return false;
    const target = resolve(dirname(fromFile), skeleton);
    return target === CORE_SOURCE_DIR || target.startsWith(`${CORE_SOURCE_DIR}${sep}`);
  });
}

/**
 * Every value import in one file, with the line and source text to quote back —
 * plus the statements that were free *only* because inline `type` is erased.
 * That second list is what lets the green run say which setting it is standing
 * on, instead of leaving the reader to trust a comment.
 */
function valueImportsOf(absPath, inlineTypeErased) {
  const text = readFileSync(absPath, "utf8");
  const source = ts.createSourceFile(absPath, text, ts.ScriptTarget.ES2022, true, scriptKindOf(absPath));
  const edges = [];
  const inlineTypeErasures = [];

  const quote = (node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const snippet = text
      .slice(node.getStart(source), node.getEnd())
      .split("\n")[0]
      .trim()
      .replace(/\s+/g, " ");
    return { line: line + 1, snippet };
  };

  const record = (node, specifierNode, form) => {
    if (specifierNode && (ts.isStringLiteral(specifierNode) || ts.isNoSubstitutionTemplateLiteral(specifierNode))) {
      edges.push({ specifier: specifierNode.text, unresolved: null, ...quote(node), form });
      return;
    }
    edges.push({
      specifier: null,
      unresolved: specifierNode ? specifierNode.getText(source) : "<missing argument>",
      couldTargetCore: specifierNode ? computedSpecifierCouldTargetCore(specifierNode, absPath) : false,
      ...quote(node),
      form
    });
  };

  const noteErasure = (node) => {
    if (inlineTypeErased && isInlineTypeOnly(node)) {
      inlineTypeErasures.push({ from: absPath, ...quote(node) });
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (importIsErased(node, inlineTypeErased)) noteErasure(node);
      else record(node, node.moduleSpecifier, "import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (exportIsErased(node, inlineTypeErased)) noteErasure(node);
      else record(node, node.moduleSpecifier, "re-export");
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node, node.moduleReference.expression, "import =");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node, node.arguments[0], "dynamic import()");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        record(node, node.arguments[0], "require()");
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return { edges, inlineTypeErasures };
}

// ---- resolution -------------------------------------------------------------

const FILE_SUFFIXES = [".ts", ".tsx", ".mts", ".cts", ".json", ""];

/** Relative imports carry `.js` even from `.ts` — map them back to source. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const candidates = [
    ...FILE_SUFFIXES.map((suffix) => `${stripped}${suffix}`),
    ...FILE_SUFFIXES.map((suffix) => `${base}${suffix}`),
    join(stripped, "index.ts"),
    join(base, "index.ts")
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The installable unit behind a bare specifier. `node:fs` is not installable at
 * all, but it is reported the same way: both are "not resolvable from an empty
 * packages/core/node_modules", and both keep an import statement in the output.
 */
function packageNameOf(specifier) {
  if (specifier.startsWith("node:")) return specifier;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// ---- the walk ---------------------------------------------------------------

/**
 * Breadth-first over value imports only. Reports the whole closure rather than
 * the first offending edge, so a regression that pulls in the barrel says how
 * far it reaches instead of naming one file and stopping.
 */
function runtimeClosure(entryAbs, inlineTypeErased) {
  const seen = new Set([entryAbs]);
  const queue = [{ file: entryAbs, path: [entryAbs] }];
  const edges = [];
  const packages = new Set();
  const inlineTypeErasures = [];

  while (queue.length > 0) {
    const { file, path } = queue.shift();
    const scan = valueImportsOf(file, inlineTypeErased);
    inlineTypeErasures.push(...scan.inlineTypeErasures);
    for (const edge of scan.edges) {
      if (edge.specifier === null) {
        edges.push({ ...edge, from: file, path, target: null, external: false });
        continue;
      }
      const isRelative = edge.specifier.startsWith(".");
      const target = isRelative ? resolveRelative(file, edge.specifier) : null;
      edges.push({ ...edge, from: file, path, target, external: !isRelative });
      if (!isRelative) {
        packages.add(packageNameOf(edge.specifier));
        continue;
      }
      if (!target || seen.has(target)) continue;
      seen.add(target);
      queue.push({ file: target, path: [...path, target] });
    }
  }

  return { edges, packages, modules: seen.size - 1, inlineTypeErasures };
}

// ---- the consumer list, derived from docker-compose --------------------------

const COMPOSE_SERVICE = /^ {2}([A-Za-z0-9_.-]+):\s*$/;
const COMPOSE_FILTER = /^\s+DEV_PNPM_FILTER:\s*"?([^"#]+?)"?\s*$/;

/**
 * The reason this rule is load-bearing is a handful of lines in
 * docker-compose.yml. Read them rather than restating them, so neither the
 * failure message nor the consumer list can claim a filter the repo no longer
 * has. Enough of a YAML reader to find `DEV_PNPM_FILTER` under a service and
 * nothing more — a dependency on a YAML parser in a gate that runs from `node`
 * with no build step is not worth the two regexes it replaces.
 */
function readComposeFilters() {
  if (!existsSync(COMPOSE)) return [];
  const found = [];
  let service = null;
  let inServices = false;

  for (const [index, line] of readFileSync(COMPOSE, "utf8").split("\n").entries()) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith("services:");
      service = null;
      continue;
    }
    if (!inServices || line.trim().startsWith("#")) continue;
    const head = COMPOSE_SERVICE.exec(line);
    if (head) {
      service = head[1];
      continue;
    }
    const filter = COMPOSE_FILTER.exec(line);
    if (filter && service) found.push({ service, filter: filter[1], line: index + 1 });
  }

  return found;
}

function webDevFilter() {
  return readComposeFilters().find((entry) => entry.filter.startsWith("@book-maker/web"))?.filter ?? null;
}

/** The `packages:` globs, expanded to every directory holding a package.json. */
function workspacePackages() {
  const patterns = [];
  if (existsSync(WORKSPACE_MANIFEST)) {
    let inPackages = false;
    for (const line of readFileSync(WORKSPACE_MANIFEST, "utf8").split("\n")) {
      if (/^\S/.test(line)) {
        inPackages = line.startsWith("packages:");
        continue;
      }
      if (!inPackages) continue;
      const item = /^\s*-\s*"?([^"#\s]+)"?\s*$/.exec(line);
      if (item) patterns.push(item[1]);
    }
  }

  const byName = new Map();
  for (const pattern of patterns) {
    const parent = pattern.endsWith("/*") ? pattern.slice(0, -2) : null;
    const dirs =
      parent === null
        ? [pattern]
        : existsSync(join(ROOT, parent))
          ? readdirSync(join(ROOT, parent), { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => `${parent}/${entry.name}`)
          : [];
    for (const dir of dirs) {
      const manifestPath = join(ROOT, dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name !== "string") continue;
      byName.set(manifest.name, {
        name: manifest.name,
        dir
      });
    }
  }
  return byName;
}

/** A filter may name a package or a directory; both are accepted, neither guessed. */
function findWorkspace(packages, token) {
  const cleaned = token.replace(/^\.\//, "").replace(/\/$/, "");
  if (packages.has(cleaned)) return packages.get(cleaned);
  for (const workspace of packages.values()) {
    if (workspace.dir === cleaned) return workspace;
  }
  return null;
}

/**
 * The workspaces exposed by a narrow install. `DEV_PNPM_FILTER:
 * "@book-maker/api..."` installs api *and its dependencies*, so
 * `packages/core/node_modules` is populated in that container and what api
 * imports is api's business. A filter with no `...` tail installs that project
 * alone — that is the container in which every value import of core has to
 * resolve to a file with no import statement left in it.
 *
 * A narrow filter naming no workspace is reported, not skipped, for the same
 * reason an unreadable `exports` entry is: this list is only trustworthy while
 * everything it could not read is loud.
 */
function narrowConsumers() {
  const packages = workspacePackages();
  const consumers = [];
  const unreadable = [];

  for (const entry of readComposeFilters()) {
    if (entry.filter.endsWith("...")) continue;
    const workspace = findWorkspace(packages, entry.filter.replace(/^\.\.\./, ""));
    if (!workspace) {
      unreadable.push(entry);
      continue;
    }
    consumers.push({ ...entry, workspace });
  }

  return { consumers, unreadable };
}

// ---- the consumer scan ------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "generated", "coverage"]);

function* sourceFiles(dirAbs) {
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dirAbs, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(abs);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) yield abs;
  }
}

/**
 * Every value import of core from one workspace that is not one of the declared
 * narrow subpaths. Erased imports are skipped by the same predicate the closure
 * walk uses: `import type { X } from "@book-maker/core"` costs the container
 * nothing, because the statement is gone before vite ever resolves it.
 *
 * A relative path into `packages/core/src` counts as the same offence. It is the
 * obvious way around the rule, `tsconfig`'s `rootDir` is the only thing refusing
 * it today, and the module it lands on is just as unresolvable there.
 * Computed imports are rejected only when their expression's own string pieces
 * can construct one of those two core targets. Identifiers are not traced to
 * declarations, so an unrelated `import(pluginPath)` is not made core's problem.
 */
function coreImportsOutsideSubpaths(workspaceDirAbs, allowed, inlineTypeErased) {
  const offenders = [];
  const inlineTypeErasures = [];
  let allowedCount = 0;

  for (const file of sourceFiles(workspaceDirAbs)) {
    const scan = valueImportsOf(file, inlineTypeErased);
    inlineTypeErasures.push(...scan.inlineTypeErasures);
    for (const edge of scan.edges) {
      if (edge.specifier === null) {
        if (edge.couldTargetCore) offenders.push({ ...edge, from: file, kind: "unresolved" });
        continue;
      }
      if (edge.specifier.startsWith(".")) {
        const target = resolve(dirname(file), edge.specifier);
        if (target === CORE_DIR || target.startsWith(`${CORE_DIR}${sep}`)) {
          offenders.push({ ...edge, from: file, kind: "relative" });
        }
        continue;
      }
      if (packageNameOf(edge.specifier) !== CORE_PACKAGE) continue;
      if (allowed.has(edge.specifier)) {
        allowedCount += 1;
        continue;
      }
      offenders.push({ ...edge, from: file, kind: edge.specifier === CORE_PACKAGE ? "barrel" : "undeclared" });
    }
  }

  return { offenders, allowedCount, inlineTypeErasures };
}

// ---- context for the failure message ---------------------------------------

function isNarrow(filter) {
  return filter !== null && !filter.endsWith("...");
}

function whyItMatters(filter) {
  return isNarrow(filter)
    ? [
        "Why this matters — the web dev container:",
        `  docker-compose.yml installs the web service with DEV_PNPM_FILTER: "${filter}" (no "..."),`,
        "  so packages/core/node_modules is EMPTY in that container — 263 packages, not 437.",
        "  Vite serves these modules straight out of the bind-mounted core source, which only",
        "  works while the transformed module has no import statement left in it. A value import",
        "  here breaks the web dev server at request time, while pnpm check, vite build on the",
        "  host and every test still pass — the host tree has a full install."
      ]
    : [
        "Why this matters:",
        `  docker-compose.yml's web service now uses DEV_PNPM_FILTER: "${filter ?? "<not found>"}", so an`,
        "  empty packages/core/node_modules is no longer what this rule protects (see apps/web/CLAUDE.md).",
        "  It still does two jobs: apps/web must never reach core's barrel, which pulls puppeteer,",
        "  sharp and node:fs into a Vite browser build, and each subpath must survive a wholesale",
        "  vi.mock of @book-maker/core in a suite that never wanted the barrel."
      ];
}

/** The producer side: a subpath reached something. */
function closureFixes(filter, erasure) {
  return [
    ...erasureNote(erasure),
    ...(erasure.on === true ? [""] : []),
    "Fix, in order of preference:",
    '  1. Make it a type-only import: `import type { X } from "…"`.',
    "  2. Move the value into a module this subpath does not reach.",
    ...(isNarrow(filter)
      ? [
          "  3. Do NOT widen DEV_PNPM_FILTER, and do NOT reach for the barrel from apps/web —",
          "     the barrel pulls puppeteer, sharp and node:fs, which a Vite browser build cannot take."
        ]
      : ["  3. Do NOT reach for the barrel from apps/web."])
  ];
}

/** The consumer side: a workspace named something it may not name. */
function consumerFixes(filter, allowed, erasures) {
  const strict = erasures.filter((erasure) => erasure.on === true);
  return [
    ...(strict.length > 0 ? [...erasureNote(strict[0]), ""] : []),
    "Fix, in order of preference:",
    `  1. Import one of the narrow subpaths instead: ${[...allowed].sort().join(", ") || "(none declared)"}.`,
    '  2. Add the module you need to packages/core/package.json\'s "exports" map. The other half of',
    "     this gate then proves its runtime closure is empty, which is what makes it importable here",
    "     — a module that reaches anything will fail that half rather than this one.",
    '  3. Make it type-only: `import type { X } from "@book-maker/core"` is erased at build time, so',
    "     nothing of it is resolved at runtime and the barrel costs the container nothing.",
    ...(isNarrow(filter)
      ? [
          "  Do NOT widen DEV_PNPM_FILTER to make the import resolve: that installs puppeteer, sharp,",
          "  openai and md-to-pdf into a container that only ever hands core's source to vite."
        ]
      : [])
  ];
}

// ---- the two halves ---------------------------------------------------------

function checkClosures(subpaths, erasure) {
  const problems = [];
  const clean = [];
  const relied = [];

  for (const { key, targets } of subpaths) {
    if (targets.length === 0) {
      problems.push([`${key} — the exports map gives no file for this subpath.`]);
      continue;
    }
    for (const target of targets) {
      const abs = resolve(CORE_DIR, target);
      if (!existsSync(abs)) {
        problems.push([`${key} → ${target} does not exist (packages/core/package.json points at a missing file).`]);
        continue;
      }

      const { edges, packages, modules, inlineTypeErasures } = runtimeClosure(abs, erasure.inlineTypeErased);
      relied.push(...inlineTypeErasures);
      if (edges.length === 0) {
        clean.push(key);
        continue;
      }

      const lines = [
        `${key}  (${rel(abs)})`,
        `    runtime closure is not empty: ${modules} module${modules === 1 ? "" : "s"}, ` +
          `${packages.size} package${packages.size === 1 ? "" : "s"} (${[...packages].sort().join(", ") || "none"})`
      ];
      for (const edge of edges.slice(0, MAX_REPORTED_EDGES)) {
        const via = edge.path.length > 1 ? `      reached via ${formatChain(edge.path)}\n` : "";
        const lands = edge.specifier === null
          ? `unresolved runtime specifier ${edge.unresolved}`
          : edge.external
            ? `package "${edge.specifier}"`
            : edge.target
              ? rel(edge.target)
              : `${edge.specifier} (unresolved)`;
        lines.push(`${via}      ${rel(edge.from)}:${edge.line}  ${edge.snippet}`);
        lines.push(`        → ${edge.form} of ${lands}`);
      }
      if (edges.length > MAX_REPORTED_EDGES) {
        lines.push(`      … and ${edges.length - MAX_REPORTED_EDGES} more value imports in the closure.`);
      }
      problems.push(lines);
    }
  }

  return { problems, clean, relied };
}

const OFFENCE = {
  barrel: (specifier) =>
    `import of the barrel "${specifier}" — the exports map's "." entry, which nothing keeps light`,
  undeclared: (specifier) => `import of "${specifier}", which packages/core/package.json does not export`,
  relative: (specifier) => `relative path into packages/core (${specifier}), which is the barrel rule with the label filed off`,
  unresolved: (specifier) => `unresolved runtime specifier ${specifier}, which cannot prove it stays inside the narrow exports`
};

function checkConsumers(allowed) {
  const { consumers, unreadable } = narrowConsumers();
  const problems = [];
  const unreadableProblems = [];
  const scanned = [];
  const erasures = [];
  const relied = [];

  for (const entry of unreadable) {
    unreadableProblems.push([
      `docker-compose.yml:${entry.line} — service "${entry.service}" installs DEV_PNPM_FILTER: "${entry.filter}",`,
      "    which names neither a package in pnpm-workspace.yaml nor a workspace directory.",
      "    This check cannot tell whether that container reaches packages/core, so it refuses to",
      "    assume it does not."
    ]);
  }

  for (const { service, filter, workspace } of consumers) {
    const dirAbs = join(ROOT, workspace.dir);
    if (!existsSync(dirAbs)) continue;
    // Each workspace answers for its own tree: the option that governs a file is the one nearest it.
    const erasure = erasureFor(join(dirAbs, "tsconfig.json"));
    erasures.push(erasure);
    if (erasure.unreadable !== undefined) continue;
    const { offenders, allowedCount, inlineTypeErasures } = coreImportsOutsideSubpaths(
      dirAbs,
      allowed,
      erasure.inlineTypeErased
    );
    relied.push(...inlineTypeErasures);
    scanned.push({ service, filter, workspace, allowedCount, offenders: offenders.length });
    if (offenders.length === 0) continue;

    const lines = [
      `${workspace.dir} (${workspace.name}, docker-compose service "${service}", DEV_PNPM_FILTER: "${filter}")`,
      `    ${offenders.length} runtime import${offenders.length === 1 ? "" : "s"} reaching packages/core outside its narrow subpath exports or carrying an unresolved specifier`
    ];
    for (const offender of offenders.slice(0, MAX_REPORTED_EDGES)) {
      lines.push(`      ${rel(offender.from)}:${offender.line}  ${offender.snippet}`);
      lines.push(`        → ${offender.form}: ${OFFENCE[offender.kind](offender.specifier ?? offender.unresolved)}`);
    }
    if (offenders.length > MAX_REPORTED_EDGES) {
      lines.push(`      … and ${offenders.length - MAX_REPORTED_EDGES} more in this workspace.`);
    }
    problems.push(lines);
  }

  return { problems, unreadableProblems, scanned, erasures, relied, consumerCount: consumers.length };
}

/** The consumer list is only trustworthy while everything it could not read is loud. */
const UNREADABLE_FILTER_FIXES = [
  "Fix:",
  "  1. Spell the filter as the package's `name` or its workspace directory, so this check can",
  "     tell whether that container installs packages/core's dependencies.",
  '  2. Or give it a `...` tail if it is meant to install them — `"<pkg>..."` selects the project',
  "     and its dependencies, which is what api and worker do and why neither is scanned here."
];

/** Same reasoning one option over: a tsconfig this cannot read is not a tsconfig it may assume. */
const UNREADABLE_TSCONFIG_FIXES = [
  "Fix:",
  "  1. Restore the tsconfig, or point `extends` at a file this can follow — a relative path, or a",
  "     chain of them ending at tsconfig.base.json.",
  '  2. Or declare `"verbatimModuleSyntax"` in the tsconfig itself, which ends the search there.'
];

// ---- main -------------------------------------------------------------------

function reportProblems(header, problems, fixes) {
  console.error(`\n${header}\n`);
  for (const lines of problems) {
    for (const line of lines) console.error(`  ${line}`);
    console.error("");
  }
  for (const line of fixes) console.error(line ? `  ${line}` : "");
  console.error("");
}

function main() {
  let subpaths;
  try {
    subpaths = readSubpaths();
  } catch (error) {
    console.error(`check-core-subpaths: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const filter = webDevFilter();
  const allowed = new Set(subpaths.map(({ key }) => specifierFor(key)));
  const coreErasure = erasureFor(CORE_TSCONFIG);
  const closures = checkClosures(subpaths, coreErasure);
  const consumers = checkConsumers(allowed);

  const erasures = [coreErasure, ...consumers.erasures];
  const tsconfigProblems = erasures
    .filter((erasure) => erasure.unreadable !== undefined)
    .map((erasure) => [
      `${erasure.unreadable}.`,
      "    This check reads `verbatimModuleSyntax` from the tsconfig governing each tree it walks,",
      "    because that option decides whether an inline-`type` named import is erased. It could not",
      "    read this one, so it refuses to assume the answer."
    ]);

  if (closures.problems.length > 0) {
    reportProblems(
      "packages/core subpath exports must have an EMPTY runtime closure.",
      closures.problems,
      closureFixes(filter, coreErasure)
    );
  }
  if (consumers.problems.length > 0) {
    reportProblems(
      `A workspace installed without core's dependencies may only import ${CORE_PACKAGE} through a narrow subpath.`,
      consumers.problems,
      consumerFixes(filter, allowed, consumers.erasures)
    );
  }
  if (consumers.unreadableProblems.length > 0) {
    reportProblems(
      "This check derives which workspaces are exposed from docker-compose.yml, and one filter did not read.",
      consumers.unreadableProblems,
      UNREADABLE_FILTER_FIXES
    );
  }
  if (tsconfigProblems.length > 0) {
    reportProblems(
      "This check reads one compiler option to know what an erased import is, and a tsconfig did not read.",
      tsconfigProblems,
      UNREADABLE_TSCONFIG_FIXES
    );
  }
  if (
    closures.problems.length > 0 ||
    consumers.problems.length > 0 ||
    consumers.unreadableProblems.length > 0 ||
    tsconfigProblems.length > 0
  ) {
    for (const line of whyItMatters(filter)) console.error(line);
    console.error("");
    console.error("Background: packages/core/CLAUDE.md and apps/web/CLAUDE.md.");
    console.error("");
    process.exit(1);
  }

  if (filter !== null && filter.endsWith("...")) {
    console.log(
      `note: docker-compose.yml now installs web with DEV_PNPM_FILTER: "${filter}", so this rule is ` +
        "no longer what keeps that container booting. It still keeps the barrel out of a Vite build " +
        "and out of vi.mock factories — see packages/core/CLAUDE.md before relaxing it."
    );
  }
  const cleanSubpaths = closures.clean.sort();
  console.log(
    `check-core-subpaths: ${closures.clean.length} subpath export${closures.clean.length === 1 ? "" : "s"} ` +
      `${cleanSubpaths.length > 0 ? `(${cleanSubpaths.join(", ")}) ` : ""}— runtime closure empty.`
  );
  if (consumers.consumerCount === 0) {
    console.log(
      "note: no docker-compose service installs a core consumer without core's dependencies, so no " +
        "workspace was scanned for barrel imports. apps/web's ban then rests on the Vite browser build " +
        "alone, and is prose again — see apps/web/CLAUDE.md."
    );
  } else {
    for (const entry of consumers.scanned) {
      console.log(
        `check-core-subpaths: ${entry.workspace.dir} (service "${entry.service}", DEV_PNPM_FILTER: ` +
          `"${entry.filter}") — ${entry.allowedCount} core import${entry.allowedCount === 1 ? "" : "s"}, ` +
          "all narrow subpaths."
      );
    }
  }

  // What the green above is standing on. Printed only while something actually leans on it: when
  // every erased statement is spelled `import type`, the option stops mattering and so does the note.
  const relied = [...closures.relied, ...consumers.relied];
  if (relied.length > 0) {
    const where = erasures.find((erasure) => erasure.declaredIn)?.declaredIn ?? "TypeScript's own default";
    console.log(
      `note: ${relied.length} statement${relied.length === 1 ? " is" : "s are"} erased only because ` +
        `verbatimModuleSyntax is off (${where}). Turn it on and each emits \`import {} from "…"\`, ` +
        "which this gate counts as reaching the module:"
    );
    for (const statement of relied.slice(0, MAX_REPORTED_EDGES)) {
      console.log(`  ${rel(statement.from)}:${statement.line}  ${statement.snippet}`);
    }
    if (relied.length > MAX_REPORTED_EDGES) {
      console.log(`  … and ${relied.length - MAX_REPORTED_EDGES} more.`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
