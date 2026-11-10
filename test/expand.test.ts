import test from "node:test";
import assert from "node:assert/strict";

import { disposeFixtureWorkspace, fixtureWorkspace } from "./helpers.ts";

test.after(async () => {
  await disposeFixtureWorkspace();
});

test("expand returns the whole declaration, body included", async () => {
  const { engine } = await fixtureWorkspace();
  const expanded = await engine.expand("src/auth/session.ts", "SessionStore.refresh");
  assert.match(expanded.text, /refresh\(token: string\): number \{/);
  assert.match(expanded.text, /const parsed = parseInput\(token\);/);
  assert.match(expanded.text, /this.lastSize = numeric;/);
  assert.match(expanded.text, /return numeric;/);
  // The declaration ends at its closing brace, not at the next declaration.
  assert.doesNotMatch(expanded.text, /makeDefaultStore/);
  assert.equal(expanded.function.qualifiedName, "SessionStore.refresh");
});

test("expand works for top-level functions and arrow constants", async () => {
  const { engine } = await fixtureWorkspace();
  const fn = await engine.expand("src/app.ts", "main");
  assert.match(fn.text, /export function main\(tokens: string\[\]\): number \{/);
  assert.match(fn.text, /missingHelper\(total\);/);

  const arrow = await engine.expand("src/lib/impl.ts", "formatBytes");
  assert.match(arrow.text, /export const formatBytes = \(bytes: number\): string =>/);
});

test("expand accepts the function id as a selector", async () => {
  const { engine } = await fixtureWorkspace();
  const skeleton = await engine.skeleton("src/auth/session.ts");
  const refresh = skeleton.symbols.find((symbol) => symbol.qualifiedName === "SessionStore.refresh");
  assert.ok(refresh);
  const expanded = await engine.expand("src/auth/session.ts", refresh.id);
  assert.equal(expanded.function.id, refresh.id);
  assert.match(expanded.text, /refresh\(token: string\): number \{/);
});
