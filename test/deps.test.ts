import test from "node:test";
import assert from "node:assert/strict";

import { disposeFixtureWorkspace, fixtureWorkspace } from "./helpers.ts";

test.after(async () => {
  await disposeFixtureWorkspace();
});

test("deps resolves a re-export chain through barrel files", async () => {
  const { engine } = await fixtureWorkspace();
  const deps = await engine.deps("src/auth/session.ts", "SessionStore.refresh");
  const byName = new Map(deps.entries.map((entry) => [entry.qualifiedName, entry]));

  // parseInput is exported via src/lib/barrel.ts -> src/lib/overloads.ts
  const parseString = byName.get("parse");
  assert.ok(parseString, "expected parse to be resolved through the barrel");
  assert.equal(parseString.path, "src/lib/overloads.ts");
  assert.equal(parseString.external, false);

  // formatBytes comes from src/lib/index.ts -> barrel -> impl.ts
  const formatBytes = deps.entries.find((entry) => entry.name === "formatBytes");
  assert.ok(formatBytes, "expected formatBytes to be resolved through two barrels");
  assert.equal(formatBytes.path, "src/lib/impl.ts");
  assert.equal(formatBytes.signature, "const formatBytes: (bytes: number) => string");
});

test("deps picks the overload that each call site selects", async () => {
  const { engine } = await fixtureWorkspace();
  const deps = await engine.deps("src/auth/session.ts", "SessionStore.refresh");
  const parseEntries = deps.entries.filter((entry) => entry.name === "parse");
  assert.equal(parseEntries.length, 2, "string and number overloads are distinct dependencies");
  const signatures = parseEntries.map((entry) => entry.signature).sort();
  assert.deepEqual(signatures, ["parse(input: number): number", "parse(input: string): string"]);
  // Distinct overloads must not collide on one id.
  assert.equal(new Set(parseEntries.map((entry) => entry.id)).size, 2);
});

test("deps resolves method calls through an interface", async () => {
  const { engine } = await fixtureWorkspace();
  const deps = await engine.deps("src/auth/session.ts", "SessionStore.refresh");
  const notify = deps.entries.find((entry) => entry.name === "notify");
  assert.ok(notify, "expected the interface method call to resolve");
  assert.equal(notify.qualifiedName, "Notifier.notify");
  assert.equal(notify.signature, "Notifier.notify(message: string): void");
  assert.equal(notify.kind, "method");
});

test("deps resolves declarations in node_modules .d.ts files", async () => {
  const { engine } = await fixtureWorkspace();
  const deps = await engine.deps("src/app.ts", "main");
  const fixtureDep = deps.entries.find((entry) => entry.name === "createFixtureDep");
  assert.ok(fixtureDep, "expected a dependency declared in a .d.ts");
  assert.equal(fixtureDep.external, true);
  assert.match(fixtureDep.path, /^node_modules\/fixture-lib\/index\.d\.ts$/);
  assert.equal(fixtureDep.signature, "function createFixtureDep(): FixtureDep");

  const write = deps.entries.find((entry) => entry.name === "write");
  assert.ok(write, "expected the interface method from the .d.ts to resolve");
  assert.equal(write.signature, "FixtureDep.write(count: number): void");
});

test("deps reports unresolved calls instead of dropping them", async () => {
  const { engine } = await fixtureWorkspace();
  const deps = await engine.deps("src/app.ts", "main");
  const missing = deps.unresolved.find((call) => call.callee === "missingHelper");
  assert.ok(missing, "missingHelper(total) must be reported as unresolved");
  assert.equal(missing.reason, "no-definition");
  assert.ok(deps.notes.some((note) => note.kind === "unresolved"));
});

test("deps attributes calls inside closures to the closure, and says so", async () => {
  const { engine } = await fixtureWorkspace();
  const deps = await engine.deps("src/app.ts", "main");
  // store.refresh("dynamic") runs inside the arrow passed to registerHandler.
  assert.equal(
    deps.entries.filter((entry) => entry.name === "refresh").length,
    1,
    "the dynamic refresh is still reported once, from the direct call",
  );
  assert.ok(
    deps.notes.some((note) => /nested closures/.test(note.message)),
    "the dropped closure call sites must be reported in a note",
  );
});

test("deps distinguishes 'no dependencies' from 'nothing resolved'", async () => {
  const { engine } = await fixtureWorkspace();
  const stdlibOnly = await engine.deps("src/lib/overloads.ts", "parse");
  assert.equal(stdlibOnly.entries.length, 0);
  assert.ok(
    stdlibOnly.notes.some((note) => note.kind === "stdlib"),
    "calls into lib.*.d.ts are reported as standard library, not as silence",
  );
});

test("deps of an unknown symbol fails with a hint, not an empty table", async () => {
  const { engine } = await fixtureWorkspace();
  await assert.rejects(
    () => engine.deps("src/auth/session.ts", "NoSuchFunction"),
    /was not found.*available:/,
  );
});
