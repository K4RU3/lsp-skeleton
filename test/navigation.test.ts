import test from "node:test";
import assert from "node:assert/strict";

import { disposeFixtureWorkspace, fixtureWorkspace } from "./helpers.ts";

test.after(async () => {
  await disposeFixtureWorkspace();
});

test("usages finds callers across files", async () => {
  const { engine } = await fixtureWorkspace();
  const usages = await engine.usages("src/lib/impl.ts", "formatBytes");
  const paths = usages.usages.map((usage) => usage.path).sort();
  assert.deepEqual(paths, ["src/app.ts", "src/auth/session.ts"]);
  assert.ok(usages.usages.every((usage) => usage.text.length > 0));
});

test("usages with 0 results carries the dynamic-call caveat", async () => {
  const { engine } = await fixtureWorkspace();
  const usages = await engine.usages("src/app.ts", "neverCalled");
  assert.equal(usages.usages.length, 0);
  const caveat = usages.notes.find((note) => note.kind === "dynamic-dispatch");
  assert.ok(caveat, "0 usages must be explained, not presented as proof");
  assert.match(caveat.message, /does NOT mean the function is never called/);
});

test("callees lists direct calls only", async () => {
  const { engine } = await fixtureWorkspace();
  const callees = await engine.callees("src/app.ts", "main");
  const names = callees.callees.map((callee) => callee.name).sort();
  assert.deepEqual(names, ["createFixtureDep", "formatBytes", "refresh", "registerHandler", "write"]);
});

test("search finds project symbols and excludes node_modules", async () => {
  const { engine } = await fixtureWorkspace();
  const result = await engine.search("refresh");
  assert.ok(result.hits.length > 0);
  assert.ok(result.hits.every((hit) => !hit.path.includes("node_modules")));
  assert.equal(result.hits[0]?.name, "refresh");
});
