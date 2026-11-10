/**
 * Document store for one session.
 *
 * Positions cross this boundary in **byte offsets**; the LSP wire uses
 * (line, UTF-16 character) positions. {@link SourceText} owns that conversion,
 * and the session layer is its only caller.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SourceText } from "../core/source-text.ts";

/** One open document: its LSP identity, version and text. */
export interface OpenDocument {
  uri: string;
  /** Absolute filesystem path, or `null` for non-file URIs. */
  path: string | null;
  languageId: string;
  version: number;
  source: SourceText;
}

/** Document state owned by a session; nothing outside the session stores it. */
export class DocumentStore {
  readonly #documents = new Map<string, OpenDocument>();

  get(uri: string): OpenDocument | undefined {
    return this.#documents.get(uri);
  }

  /** Register or replace the document text, bumping its version. */
  set(input: { uri: string; languageId: string; text: string; version?: number }): OpenDocument {
    const previous = this.#documents.get(input.uri);
    const document: OpenDocument = {
      uri: input.uri,
      path: filePathOf(input.uri),
      languageId: input.languageId,
      version: input.version ?? (previous?.version ?? 0) + 1,
      source: new SourceText(input.text),
    };
    this.#documents.set(input.uri, document);
    return document;
  }

  delete(uri: string): void {
    this.#documents.delete(uri);
  }

  values(): OpenDocument[] {
    return [...this.#documents.values()];
  }
}

/** `file://` URI -> absolute path; other schemes yield `null`. */
export function filePathOf(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** Absolute path -> `file://` URI. */
export function uriOfFile(path: string): string {
  return pathToFileURL(path).href;
}

/** Read a file from disk as UTF-8, returning `undefined` when it is missing. */
export async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
