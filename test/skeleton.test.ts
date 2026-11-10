import test from "node:test";
import assert from "node:assert/strict";

import { disposeFixtureWorkspace, fixtureWorkspace } from "./helpers.ts";

test.after(async () => {
  await disposeFixtureWorkspace();
});

test("skeleton keeps signatures and folds bodies", async () => {
  const { engine } = await fixtureWorkspace();
  const skeleton = await engine.skeleton("src/auth/session.ts");
  assert.equal(skeleton.path, "src/auth/session.ts");

  // Class + methods + accessors, with checker-resolved types.
  assert.match(skeleton.text, /export class SessionStore \{/);
  assert.match(skeleton.text, /refresh\(token: string\): number\s+\/\/ … \d+ lines/);
  assert.match(skeleton.text, /get size\(\): number/);
  assert.match(skeleton.text, /set size\(value: number\)/);
  assert.match(skeleton.text, /makeDefaultStore\(\): SessionStore/);

  // Bodies are gone: no statement from inside a function survives.
  assert.doesNotMatch(skeleton.text, /const parsed = parseInput/);
  assert.doesNotMatch(skeleton.text, /this.lastSize = numeric/);

  // JSDoc summary is preserved.
  assert.match(skeleton.text, /\/\*\* Refresh the session for a token and return the new size\. \*\//);

  // Exports summary.
  assert.match(skeleton.text, /\/\/ exports: makeDefaultStore, SessionStore/);
});

test("skeleton includes type definitions, globals and the export list", async () => {
  const { engine } = await fixtureWorkspace();
  const skeleton = await engine.skeleton("src/lib/impl.ts");
  assert.match(skeleton.text, /export interface Notifier \{/);
  assert.match(skeleton.text, /export type Result<T> =/);
  assert.match(skeleton.text, /export enum Level \{/);
  assert.match(skeleton.text, /export class ConsoleNotifier implements Notifier/);
  assert.match(skeleton.text, /\/\/ exports: ConsoleNotifier, Level, Notifier, Result, wrap/);
  // The arrow function assigned to a const keeps the checker's function type.
  assert.match(skeleton.text, /const formatBytes: \(bytes: number\) => string/);
});

test("skeleton keeps top-level statements of a module", async () => {
  const { engine } = await fixtureWorkspace();
  const skeleton = await engine.skeleton("src/app.ts");
  assert.match(skeleton.text, /import \{ SessionStore \} from "\.\/auth\/session";/);
  assert.match(skeleton.text, /const handlers: \(\(\) => void\)\[\]/);
  assert.match(skeleton.text, /export function main\(tokens: string\[\]\): number/);
});

test("skeleton symbols carry stable function ids", async () => {
  const { engine } = await fixtureWorkspace();
  const skeleton = await engine.skeleton("src/auth/session.ts");
  const refresh = skeleton.symbols.find((symbol) => symbol.qualifiedName === "SessionStore.refresh");
  assert.ok(refresh, "expected SessionStore.refresh");
  assert.match(refresh.id, /^src\/auth\/session\.ts#SessionStore\.refresh@[0-9a-f]{6}$/);
});

test("overloaded declarations are listed individually", async () => {
  const { engine } = await fixtureWorkspace();
  const symbols = await engine.listSymbols("src/lib/overloads.ts");
  const parses = symbols.filter((symbol) => symbol.name === "parse");
  assert.equal(parses.length, 3, "two overloads + one implementation");
  assert.deepEqual(
    parses.map((symbol) => symbol.signature),
    [
      "function parse(input: string): string",
      "function parse(input: number): number",
      // The implementation's own annotated signature, which hover does not
      // report (it repeats the first overload instead).
      "function parse(input: string | number): string | number",
    ],
  );
});
