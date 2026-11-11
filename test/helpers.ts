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
export const rustFixtureRoot = path.join(repoRoot, "fixtures/rust-project");

let shared: Promise<Workspace> | undefined;
let sharedRust: Promise<Workspace | undefined> | undefined;

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

/**
 * The shared workspace for the Rust fixture crate.
 *
 * rust-analyzer is not a dependency of this package: it is whatever the user
 * has installed (see resolveRustAnalyzer). When it cannot be started at all,
 * the Rust tests skip instead of failing, so the suite still runs on a
 * machine without a Rust toolchain.
 */
export async function rustWorkspace(): Promise<Workspace | undefined> {
  sharedRust ??= createWorkspace({
    root: rustFixtureRoot,
    server: "rust-analyzer",
    readinessTimeoutMs: 180_000,
  }).then(
    (workspace) => workspace,
    (error: unknown) => {
      process.stderr.write(`[rust tests skipped] ${String(error)}\n`);
      return undefined;
    },
  );
  return sharedRust;
}

/** Dispose the shared workspaces (call once from the test file's after hook). */
export async function disposeFixtureWorkspace(): Promise<void> {
  if (shared !== undefined) {
    const workspace = await shared;
    workspace.dispose();
    shared = undefined;
  }
  if (sharedRust !== undefined) {
    const workspace = await sharedRust;
    workspace?.dispose();
    sharedRust = undefined;
  }
}