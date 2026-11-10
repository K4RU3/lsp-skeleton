/**
 * Text document store and the UTF-16 <-> byte position conversions.
 *
 * LSP positions are (line, character) with character counted in UTF-16 code
 * units. Everything above this module speaks only `number` (byte offsets) in
 * which the session layer hands out and accepts.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Converts between the two coordinate systems of one file's text. */
export class TextLines {
  readonly #text: string;
  readonly #lineStarts: number[];

  constructor(text: string) {
    this.#text = text;
    const starts: number[] = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) starts.push(index + 1);
    }
    this.#lineStarts = starts;
  }

  get text(): string {
    return this.#text;
  }

  get lineCount(): number {
    return this.#lineStarts.length;
  }

  /** UTF-16 offset of the first character of `line` (0-based). */
  lineStart(line: number): number {
    const start = this.#lineStarts[line];
    if (start === undefined) throw new RangeError(`line ${line} out of range`);
    return start;
  }

  /** LSP position -> UTF-16 offset, clamped to the line end (LSP's own rule). */
  offsetAt(position: { line: number; character: number }): number {
    const line = Math.max(0, Math.min(position.line, this.#lineStarts.length - 1));
    const start = this.#lineStarts[line] ?? 0;
    const end = this.#lineStarts[line + 1] ?? this.#text.length + 1;
    return Math.min(start + Math.max(0, position.character), end - 1);
  }

  /** UTF-16 offset -> LSP position. */
  positionAt(offset: number): { line: number; character: number } {
    const clamped = Math.max(0, Math.min(offset, this.#text.length));
    let low = 0;
    let high = this.#lineStarts.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if ((this.#lineStarts[middle] ?? 0) <= clamped) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: clamped - (this.#lineStarts[low] ?? 0) };
  }

  /** Byte offset -> LSP position; the inverse of {@link byteOffsetAt}. */
  positionAtByte(byteOffset: number): { line: number; character: number } {
    return this.positionAt(this.#utf16OffsetAtByte(byteOffset));
  }

  /** LSP position -> byte offset. */
  byteOffsetAt(position: { line: number; character: number }): number {
    return this.#byteOffsetAtUtf16(this.offsetAt(position));
  }

  #utf16OffsetAtByte(byteOffset: number): number {
    const buffer = Buffer.from(this.#text, "utf8");
    return buffer.subarray(0, Math.max(0, Math.min(byteOffset, buffer.length))).toString("utf8").length;
  }

  #byteOffsetAtUtf16(utf16Offset: number): number {
    return Buffer.byteLength(this.#text.slice(0, utf16Offset), "utf8");
  }
}

/** One open LSP document: version, text and derived conversion tables. */
export interface OpenDocument {
  uri: string;
  /** Absolute filesystem path, or `null` for non-file URIs. */
  path: string | null;
  languageId: string;
  version: number;
  lines: TextLines;
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
      lines: new TextLines(input.text),
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
