/**
 * One file's text plus the conversions every layer needs.
 *
 * The query layer's public position unit is a **byte offset**. JavaScript
 * strings (and therefore TypeScript node positions and LSP `character` counts)
 * use **UTF-16 code units**. All three meet here, so no other module has to
 * think about which unit it is holding.
 *
 * Both direction tables are built in one pass and cover every byte, so a byte
 * offset that lands inside a multi-byte character snaps to the start of that
 * character instead of producing a broken string index.
 */
export class SourceText {
  readonly #text: string;
  /** UTF-16 offset of each line start (index = 0-based line). */
  readonly #lineStarts: number[];
  /** Byte offset of the character starting at each UTF-16 offset. */
  readonly #utf16ToByte: Int32Array;
  /** UTF-16 offset of the character containing each byte offset. */
  readonly #byteToUtf16: Int32Array;
  readonly #byteLength: number;

  constructor(text: string) {
    this.#text = text;
    const lineStarts: number[] = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) lineStarts.push(index + 1);
    }
    this.#lineStarts = lineStarts;

    const byteLength = Buffer.byteLength(text, "utf8");
    const utf16ToByte = new Int32Array(text.length + 1);
    const byteToUtf16 = new Int32Array(byteLength + 1);
    let byte = 0;
    let index = 0;
    while (index < text.length) {
      const codePoint = text.codePointAt(index) ?? 0;
      const units = codePoint > 0xffff ? 2 : 1;
      const bytes = Buffer.byteLength(String.fromCodePoint(codePoint), "utf8");
      utf16ToByte[index] = byte;
      if (units === 2) utf16ToByte[index + 1] = byte; // inside a surrogate pair
      for (let offset = 0; offset < bytes; offset += 1) byteToUtf16[byte + offset] = index;
      index += units;
      byte += bytes;
    }
    utf16ToByte[text.length] = byte;
    byteToUtf16[byte] = text.length;
    this.#utf16ToByte = utf16ToByte;
    this.#byteToUtf16 = byteToUtf16;
    this.#byteLength = byte;
  }

  get text(): string {
    return this.#text;
  }

  /** Total length in bytes. */
  get byteLength(): number {
    return this.#byteLength;
  }

  /** Number of lines (a trailing newline does not create an extra line). */
  get lineCount(): number {
    return this.#lineStarts.length;
  }

  /** UTF-16 offset for a byte offset; offsets inside a character snap left. */
  toUtf16(byteOffset: number): number {
    const clamped = Math.max(0, Math.min(Math.trunc(byteOffset), this.#byteLength));
    return this.#byteToUtf16[clamped] ?? 0;
  }

  /** Byte offset for a UTF-16 offset; offsets inside a pair snap to its start. */
  toByte(utf16Offset: number): number {
    const clamped = Math.max(0, Math.min(Math.trunc(utf16Offset), this.#text.length));
    return this.#utf16ToByte[clamped] ?? this.#byteLength;
  }

  /** Substring between two byte offsets. */
  slice(startByte: number, endByte: number): string {
    return this.#text.slice(this.toUtf16(startByte), this.toUtf16(endByte));
  }

  /** Number of lines a byte range spans (an empty range counts as 0). */
  linesIn(startByte: number, endByte: number): number {
    if (endByte <= startByte) return 0;
    return this.positionAt(endByte).line - this.positionAt(startByte).line + 1;
  }

  /** LSP position -> byte offset, clamping `character` to the line end. */
  byteAt(position: { line: number; character: number }): number {
    const line = Math.max(0, Math.min(position.line, this.#lineStarts.length - 1));
    const start = this.#lineStarts[line] ?? 0;
    const end = this.#lineStarts[line + 1] ?? this.#text.length + 1;
    return this.toByte(Math.min(start + Math.max(0, position.character), end - 1));
  }

  /** Byte offset -> LSP position. */
  positionAt(byteOffset: number): { line: number; character: number } {
    const utf16 = this.toUtf16(byteOffset);
    let low = 0;
    let high = this.#lineStarts.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if ((this.#lineStarts[middle] ?? 0) <= utf16) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: utf16 - (this.#lineStarts[low] ?? 0) };
  }

  /** 1-based line number of a byte offset. */
  lineAt(byteOffset: number): number {
    return this.positionAt(byteOffset).line + 1;
  }
}
