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
  /**
   * Format version; entries from another version are ignored.
   *
   * Bump when the *shape* of a cached value changes meaning, not just when the
   * file content does: the key only covers the source text, so a semantic fix
   * would otherwise keep replaying stale entries. Version 2 sorts symbols into
   * document order (see symbols.ts), so entries written before that fix must be
   * discarded rather than served. See {@link CACHE_VERSION}.
   */
  version?: number;
}

/**
 * Cache format version. Bump whenever a cached value's meaning changes.
 *
 * 2: symbol trees are stored in document order (previously documentSymbol's
 *    alphabetical order), so version 1 entries would render reversed.
 */
export const CACHE_VERSION = 2;

/** A content-addressed JSON file cache. */
export class FileCache {
  readonly #directory: string;
  readonly #version: number;

  constructor(options: FileCacheOptions) {
    this.#directory = path.resolve(options.directory);
    this.#version = options.version ?? CACHE_VERSION;
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
