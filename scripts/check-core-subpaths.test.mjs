import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readVerbatimModuleSyntax } from "./check-core-subpaths.mjs";

const fixtureDir = mkdtempSync(join(tmpdir(), "check-core-subpaths-"));
after(() => rmSync(fixtureDir, { recursive: true, force: true }));

function writeConfig(name, config) {
  const path = join(fixtureDir, name);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

const trueConfig = writeConfig("true.json", {
  compilerOptions: { verbatimModuleSyntax: true }
});
const falseConfig = writeConfig("false.json", {
  compilerOptions: { verbatimModuleSyntax: false }
});
writeConfig("empty.json", {});

test("an undeclared later parent preserves an earlier parent declaration", () => {
  const config = writeConfig("later-undeclared.json", {
    extends: ["./true.json", "./empty.json"]
  });

  assert.deepEqual(readVerbatimModuleSyntax(config), { on: true, from: trueConfig });
});

test("an explicit later parent declaration wins", () => {
  const config = writeConfig("later-false.json", {
    extends: ["./true.json", "./false.json"]
  });

  assert.deepEqual(readVerbatimModuleSyntax(config), { on: false, from: falseConfig });
});

test("nested extends arrays preserve inherited declarations", () => {
  writeConfig("nested-parent.json", {
    extends: ["./true.json", "./empty.json"]
  });
  const config = writeConfig("nested-child.json", {
    extends: "./nested-parent.json"
  });

  assert.deepEqual(readVerbatimModuleSyntax(config), { on: true, from: trueConfig });
});

const checker = fileURLToPath(new URL("./check-core-subpaths.mjs", import.meta.url));

function writeFixtureFile(root, relativePath, value) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function emptyExportsFixture(name, consumerSource) {
  const root = join(fixtureDir, name);
  const write = (relativePath, value) => writeFixtureFile(root, relativePath, value);
  write("packages/core/package.json", JSON.stringify({ name: "@book-maker/core", exports: { ".": "./src/index.ts" } }));
  write("packages/core/src/index.ts", "export {};\n");
  write("packages/core/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.base.json" }));
  write("apps/web/package.json", JSON.stringify({ name: "@book-maker/web", dependencies: { "@book-maker/core": "workspace:*" } }));
  write("apps/web/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.base.json" }));
  write("apps/web/src/consumer.ts", consumerSource);
  write("tsconfig.base.json", JSON.stringify({ compilerOptions: { verbatimModuleSyntax: false } }));
  write("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  write("docker-compose.yml", 'services:\n  web:\n    environment:\n      DEV_PNPM_FILTER: "@book-maker/web"\n');
  return root;
}

function narrowEntryFixture(name, entrySource, extraFiles = {}) {
  const root = emptyExportsFixture(name, "export const value = 1;\n");
  writeFixtureFile(
    root,
    "packages/core/package.json",
    JSON.stringify({
      name: "@book-maker/core",
      exports: { ".": "./src/index.ts", "./narrow": "./src/narrow.ts" }
    })
  );
  writeFixtureFile(root, "packages/core/src/narrow.ts", entrySource);
  for (const [relativePath, value] of Object.entries(extraFiles)) {
    writeFixtureFile(root, `packages/core/src/${relativePath}`, value);
  }
  return root;
}

function runFixture(root) {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    env: { ...process.env, CHECK_CORE_SUBPATHS_ROOT: root },
    encoding: "utf8"
  });
}

for (const [name, specifier] of [
  ["barrel", "@book-maker/core"],
  ["undeclared subpath", "@book-maker/core/jobSteps"]
]) {
  test(`empty narrow exports still reject a consumer ${name} import`, () => {
    const result = runFixture(
      emptyExportsFixture(`empty-exports-${name.replaceAll(" ", "-")}`, `import { value } from "${specifier}";\nvoid value;\n`)
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside its narrow subpath exports/);
    assert.match(result.stderr, new RegExp(specifier.replaceAll("/", "\\/")));
  });
}

test("a narrow consumer without a manifest dependency passes when it has no core import", () => {
  const root = emptyExportsFixture("empty-exports-clean", "export const value = 1;\n");
  writeFixtureFile(root, "apps/web/package.json", JSON.stringify({ name: "@book-maker/web" }));

  const result = runFixture(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 subpath exports — runtime closure empty/);
  assert.match(result.stdout, /apps\/web .* all narrow subpaths/);
});

test("a narrow consumer rejects a relative core import without a manifest dependency", () => {
  const root = emptyExportsFixture(
    "relative-core-without-dependency",
    'import "../../../packages/core/src/index.js";\n'
  );
  writeFixtureFile(root, "apps/web/package.json", JSON.stringify({ name: "@book-maker/web" }));

  const result = runFixture(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside its narrow subpath exports/);
  assert.match(result.stderr, /relative path into packages\/core .*packages\/core\/src\/index\.js/);
});

for (const [name, source, form] of [
  ["computed dynamic import", 'const name = "./dep.js"; void import(name);\n', "dynamic import()"],
  ["computed require", 'const name = "./dep.js"; void require(name);\n', "require()"],
  ["template expression", 'const name = "dep"; void import(`./${name}.js`);\n', "dynamic import()"]
]) {
  test(`a narrow entry rejects a ${name} as an unresolved runtime edge`, () => {
    const result = runFixture(narrowEntryFixture(`unresolved-${name.replaceAll(" ", "-")}`, source));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /runtime closure is not empty/);
    assert.match(result.stderr, new RegExp(`${form.replace(/[()]/g, "\\$&")} of unresolved runtime specifier`));
  });
}

test("a no-substitution template literal resolves and counts its dependency closure", () => {
  const result = runFixture(
    narrowEntryFixture("literal-template", "void import(`./dep.js`);\n", { "dep.ts": "export const value = 1;\n" })
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime closure is not empty: 1 module, 0 packages/);
  assert.match(result.stderr, /dynamic import\(\) of packages\/core\/src\/dep.ts/);
});

test("a narrow consumer permits an unrelated computed local dynamic import", () => {
  const result = runFixture(
    emptyExportsFixture(
      "consumer-computed-local-import",
      'const path = "./local.js"; void import(path);\n'
    )
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /apps\/web .* all narrow subpaths/);
});

test("a narrow consumer rejects a computed runtime specifier that can target core", () => {
  const result = runFixture(
    emptyExportsFixture(
      "consumer-computed-core-import",
      'const subpath = "jobSteps"; void import(`@book-maker/core/${subpath}`);\n'
    )
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside its narrow subpath exports or carrying an unresolved specifier/);
  assert.match(result.stderr, /dynamic import\(\): unresolved runtime specifier `@book-maker\/core\/\$\{subpath\}`/);
});

test("a narrow consumer rejects a computed relative path into core source", () => {
  const result = runFixture(
    emptyExportsFixture(
      "consumer-computed-relative-core-import",
      'const moduleName = "index.js"; void import(`../../../packages/core/src/${moduleName}`);\n'
    )
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside its narrow subpath exports or carrying an unresolved specifier/);
  assert.match(result.stderr, /unresolved runtime specifier `\.\.\/\.\.\/\.\.\/packages\/core\/src\/\$\{moduleName\}`/);
});
