import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileCache } from "../src/cache/file-cache.ts";
import { createWorkspace } from "../src/index.ts";
import { fixtureRoot } from "./helpers.ts";

test("FileCache is content-addressed and version-scoped", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lsp-skeleton-cache-"));
  try {
    const cache = new FileCache({ directory, version: 1 });
    const hash = FileCache.contentHash("export const a = 1;");
    const key = FileCache.key("src/a.ts", hash, "typescript-language-server");
    assert.equal(await cache.read(key, hash), undefined);

    await cache.write(key, hash, { value: 42 });
    assert.deepEqual(await cache.read<{ value: number }>(key, hash), { value: 42 });

    // A changed file produces a different hash, so the old entry is a miss.
    assert.equal(await cache.read(key, FileCache.contentHash("export const a = 2;")), undefined);

    // A bumped format version invalidates every entry.
    const newer = new FileCache({ directory, version: 2 });
    assert.equal(await newer.read(key, hash), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the on-disk cache is used across sessions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lsp-skeleton-cache-"));
  try {
    const first = await createWorkspace({ root: fixtureRoot, cacheDirectory: directory });
    let skeleton;
    try {
      skeleton = await first.engine.skeleton("src/auth/session.ts");
    } finally {
      first.dispose();
    }
    const entries = await readdir(directory);
    assert.ok(entries.length > 0, "the skeleton must be persisted");

    // A brand-new session (new server process) answers from the cache.
    const second = await createWorkspace({ root: fixtureRoot, cacheDirectory: directory });
    try {
      const cached = await second.engine.skeleton("src/auth/session.ts");
      assert.equal(cached.text, skeleton.text);
      assert.deepEqual(
        cached.symbols.map((symbol) => symbol.id),
        skeleton.symbols.map((symbol) => symbol.id),
      );
    } finally {
      second.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
