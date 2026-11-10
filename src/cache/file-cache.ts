/**
 * Persistent result cache, deliberately outside the LSP session.
 *
 * Sessions are disposable and hold no durable state; this cache lives on disk
 * and uses the file content hash as its key, so a session can die (or never
 * exist) without affecting cached answers.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CacheEntry<T> {
  /** Cache format version; bump to invalidate every entry. */
  version: number;
  /** Content hash the entry was computed from. */
  contentHash: string;
  /** ISO timestamp, for diagnostics only. */
  createdAt: string;
  value: T;
}

export interface FileCacheOptions {
  /** Directory holding cache files. Created on first write. */
  directory: string;
  /** Format version; entries from another version are ignored. */
  version?: number;
}

/** A content-addressed JSON file cache. */
export class FileCache {
  readonly #directory: string;
  readonly #version: number;

  constructor(options: FileCacheOptions) {
    this.#directory = path.resolve(options.directory);
    this.#version = options.version ?? 1;
  }

  get directory(): string {
    return this.#directory;
  }

  /** Stable content hash used as part of the cache key. */
  static contentHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  /** Cache key: file path + content hash + caller-supplied variant. */
  static key(relativePath: string, contentHash: string, variant = ""): string {
    return createHash("sha256").update(`${relativePath}\u0000${contentHash}\u0000${variant}`).digest("hex").slice(0, 40);
  }

  /** Read a cached entry; a miss, a version bump or bad JSON returns undefined. */
  async read<T>(key: string, contentHash: string): Promise<T | undefined> {
    const file = this.#file(key);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    try {
      const entry = JSON.parse(raw) as CacheEntry<T>;
      if (entry.version !== this.#version) return undefined;
      if (entry.contentHash !== contentHash) return undefined;
      return entry.value;
    } catch {
      return undefined;
    }
  }

  /** Write a cached entry (best-effort: a failed write never fails the query). */
  async write<T>(key: string, contentHash: string, value: T): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true });
      const entry: CacheEntry<T> = {
        version: this.#version,
        contentHash,
        createdAt: new Date().toISOString(),
        value,
      };
      await writeFile(this.#file(key), JSON.stringify(entry), "utf8");
    } catch {
      // Caching is an optimisation; the query already succeeded.
    }
  }

  #file(key: string): string {
    return path.join(this.#directory, `${key}.json`);
  }
}
