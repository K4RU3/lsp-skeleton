import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { startSession, serverSpec } from "../src/lsp/server-factory.ts";
import { fixtureRoot } from "./helpers.ts";

test("session negotiates capabilities and reports readiness", async () => {
  const session = await startSession({ workspaceRoot: fixtureRoot, readinessTimeoutMs: 60_000 });
  try {
    assert.equal(session.serverName, "typescript-language-server");
    assert.equal(session.hasDocumentSymbol, true);
    assert.equal(session.hasHover, true);
    assert.equal(session.hasDefinition, true);
    const opened = await session.openDocument("src/app.ts");
    assert.equal(opened.path, path.join(fixtureRoot, "src/app.ts"));
    const readiness = await session.waitForProjectLoad();
    assert.equal(readiness.ready, true);
    // The server does report progress; the session must have observed it.
    assert.notEqual(readiness.signal, "quiet");
  } finally {
    session.dispose();
  }
});

test("session converts byte offsets and LSP positions losslessly", async () => {
  const session = await startSession({ workspaceRoot: fixtureRoot, readinessTimeoutMs: 60_000 });
  try {
    const document = await session.openDocument("src/auth/session.ts");
    const source = document.source;
    for (const offset of [0, 10, 100, 375, source.byteLength]) {
      const position = source.positionAt(offset);
      assert.equal(source.byteAt(position), offset);
    }
  } finally {
    session.dispose();
  }
});

test("session serves both supported servers", async () => {
  for (const server of ["typescript-language-server", "vtsls"] as const) {
    const spec = serverSpec(server);
    const session = await startSession({ workspaceRoot: fixtureRoot, server, readinessTimeoutMs: 60_000 });
    try {
      const symbols = await session.documentSymbols("src/auth/session.ts");
      assert.ok(symbols.length > 0, `${server} must return documentSymbols`);
      assert.equal(spec.name, server);
    } finally {
      session.dispose();
    }
  }
});
