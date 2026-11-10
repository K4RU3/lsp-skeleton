/**
 * Test helpers: one shared language-server session per fixture project.
 *
 * Starting a server costs ~100ms + project load, so the suite shares one
 * session across tests and disposes it at the end.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createWorkspace, type Workspace } from "../src/index.ts";
import type { ServerName } from "../src/lsp/server-factory.ts";

const run = promisify(execFile);

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureRoot = path.join(repoRoot, "fixtures/fixture-project");

let shared: Promise<Workspace> | undefined;

/**
 * The fixture's `.d.ts` dependency is generated (not committed), so a fresh
 * clone must create it before the suite runs.
 */
export async function ensureFixtureDependency(): Promise<void> {
  const manifest = path.join(fixtureRoot, "node_modules/fixture-lib/package.json");
  if (existsSync(manifest)) return;
  await run(process.execPath, ["--experimental-strip-types", path.join(repoRoot, "scripts/setup-fixture.ts")]);
}

/** The shared workspace for the fixture project. */
export async function fixtureWorkspace(server?: ServerName): Promise<Workspace> {
  await ensureFixtureDependency();
  shared ??= createWorkspace({
    root: fixtureRoot,
    readinessTimeoutMs: 60_000,
    ...(server === undefined ? {} : { server }),
  });
  return shared;
}

/** Dispose the shared workspace (call once from the test file's after hook). */
export async function disposeFixtureWorkspace(): Promise<void> {
  if (shared === undefined) return;
  const workspace = await shared;
  workspace.dispose();
  shared = undefined;
}
