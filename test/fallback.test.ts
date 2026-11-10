import test from "node:test";
import assert from "node:assert/strict";

import { QueryEngine } from "../src/core/query.ts";
import { fixtureRoot } from "./helpers.ts";
import { startSession } from "../src/lsp/server-factory.ts";

/**
 * §5.5: when the server does not advertise callHierarchy, the query layer must
 * fall back to definition-based resolution *inside* itself, producing the same
 * result shape. The capability is hidden here to exercise that path against a
 * real server.
 */
function withoutCallHierarchy<T extends object>(session: T): T {
  Object.defineProperty(session, "hasCallHierarchy", { get: () => false, configurable: true });
  return session;
}

test("definition-based fallback resolves the same dependencies", async () => {
  const session = withoutCallHierarchy(await startSession({ workspaceRoot: fixtureRoot, readinessTimeoutMs: 60_000 }));
  const engine = new QueryEngine(session);
  try {
    const deps = await engine.deps("src/auth/session.ts", "SessionStore.refresh");
    const names = deps.entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, ["formatBytes", "notify", "parse", "parse"]);
    assert.ok(
      deps.notes.some((note) => note.kind === "fallback"),
      "the fallback must be visible in the notes",
    );
    // Overload selection still works: it comes from signatureHelp, not hierarchy.
    const signatures = deps.entries
      .filter((entry) => entry.name === "parse")
      .map((entry) => entry.signature)
      .sort();
    assert.deepEqual(signatures, ["parse(input: number): number", "parse(input: string): string"]);

    // Unresolved calls are still surfaced on this path.
    const main = await engine.deps("src/app.ts", "main");
    assert.ok(main.unresolved.some((call) => call.callee === "missingHelper"));
  } finally {
    session.dispose();
  }
});

test("usages fall back to references when callHierarchy is missing", async () => {
  const session = withoutCallHierarchy(await startSession({ workspaceRoot: fixtureRoot, readinessTimeoutMs: 60_000 }));
  const engine = new QueryEngine(session);
  try {
    const usages = await engine.usages("src/lib/impl.ts", "formatBytes");
    assert.deepEqual(
      usages.usages.map((usage) => usage.path).sort(),
      ["src/app.ts", "src/auth/session.ts"],
    );
    assert.ok(usages.notes.some((note) => note.kind === "fallback"));
  } finally {
    session.dispose();
  }
});
