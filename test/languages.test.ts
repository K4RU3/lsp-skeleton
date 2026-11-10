import test from "node:test";
import assert from "node:assert/strict";

import { disposeFixtureWorkspace, fixtureWorkspace } from "./helpers.ts";

test.after(async () => {
  await disposeFixtureWorkspace();
});

test("JavaScript files get checker-inferred signatures from JSDoc", async () => {
  const { engine } = await fixtureWorkspace();
  const skeleton = await engine.skeleton("src/legacy.js");
  assert.match(skeleton.text, /function greetLegacy\(name: string\): string/);
  assert.match(skeleton.text, /function repeatLegacy\(count: number\): string\[\]/);
  assert.match(skeleton.text, /const VERSION: "1\.0\.0"/);
  assert.doesNotMatch(skeleton.text, /return "hello "/);
});

test(".mts files are supported", async () => {
  const { engine } = await fixtureWorkspace();
  const skeleton = await engine.skeleton("src/modern.mts");
  assert.match(skeleton.text, /function square\(value: number\): number/);
  assert.match(skeleton.text, /const cube: \(value: number\) => number/);

  const expanded = await engine.expand("src/modern.mts", "cube");
  assert.match(expanded.text, /value \* square\(value\)/);
});

test("deps follows a JavaScript caller into TypeScript declarations", async () => {
  const { engine } = await fixtureWorkspace();
  const deps = await engine.deps("src/legacy.js", "repeatLegacy");
  assert.deepEqual(
    deps.entries.map((entry) => entry.name),
    ["greetLegacy"],
  );
  assert.equal(deps.unresolved.length, 0);
});
