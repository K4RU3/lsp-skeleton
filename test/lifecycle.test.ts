import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { startSession, serverSpec } from "../src/lsp/server-factory.ts";
import { fixtureRoot } from "./helpers.ts";

/** PID of the language-server child owned by this process, if one is live. */
function ownServerPid(): number | undefined {
  try {
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const pid = Number.parseInt(parts[0] ?? "", 10);
      const ppid = Number.parseInt(parts[1] ?? "", 10);
      if (ppid !== process.pid) continue;
      if (!line.includes("typescript-language-server") && !line.includes("vtsls")) continue;
      if (Number.isFinite(pid)) return pid;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * §5.7: the session owns the server process. Disposing must not leave a
 * zombie, and a server that dies must fail pending work instead of hanging.
 */
test("dispose terminates the server process", async () => {
  const session = await startSession({ workspaceRoot: fixtureRoot, readinessTimeoutMs: 60_000 });
  try {
    await session.openDocument("src/app.ts");
    await session.waitForProjectLoad();
    const pid = ownServerPid();
    assert.ok(pid !== undefined && pid > 0, "expected a live server child of this test process");
    session.dispose();
    await waitFor(() => !isAlive(pid), 5_000);
    assert.equal(isAlive(pid), false, "server process must be gone after dispose");
  } finally {
    session.dispose();
  }
});

test("a killed server fails pending requests instead of hanging", async () => {
  const session = await startSession({ workspaceRoot: fixtureRoot, readinessTimeoutMs: 60_000 });
  try {
    await session.openDocument("src/app.ts");
    await session.waitForProjectLoad();
    const pid = ownServerPid();
    assert.ok(pid !== undefined, "expected a live server child");
    process.kill(pid, "SIGKILL");
    await assert.rejects(
      () => session.documentSymbols("src/auth/session.ts"),
      /language server exited|session disposed/,
    );
  } finally {
    session.dispose();
  }
});

test("server specs point at real entry points", () => {
  for (const server of ["typescript-language-server", "vtsls"] as const) {
    const spec = serverSpec(server);
    assert.equal(spec.name, server);
    assert.ok(path.isAbsolute(spec.command));
    const entry = spec.args[0];
    assert.ok(entry !== undefined && path.isAbsolute(entry));
  }
});
