/**
 * Rust declarations as the query layer needs them: names, headers, bodies,
 * docs and modifiers.
 *
 * Built on the scanner in 'rust-scanner.ts'. Nothing here guesses: an item the
 * scanner cannot bound returns undefined, and the caller falls back to the
 * server's own range.
 */
import type { BodySpan } from "../languages/types.ts";
import { innermostItem, maskRust, nextToken, parseItemsIn, type RustItem } from "./rust-scanner.ts";

export type { RustItem, RustToken } from "./rust-scanner.ts";
export { maskRust, nextToken, parseItem, parseItemsIn, parseTopLevelItems, innermostItem } from "./rust-scanner.ts";

/** The innermost item that contains a byte range, converted to UTF-16. */
export function itemForRange(
  text: string,
  mask: Uint8Array,
  range: { start: number },
  toUtf16: (byteOffset: number) => number,
): RustItem | undefined {
  return innermostItem(text, mask, toUtf16(range.start));
}

/** Drop leading doc comments and #[...] attributes from a header slice. */
export function stripLeadingAttributes(text: string): string {
  let rest = text;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("//")) {
      const newline = trimmed.indexOf("\n");
      if (newline < 0) return "";
      rest = trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) return "";
      rest = trimmed.slice(close + 2);
      continue;
    }
    if (trimmed.startsWith("#[")) {
      let depth = 0;
      let at = 0;
      for (; at < trimmed.length; at += 1) {
        if (trimmed[at] === "[") depth += 1;
        else if (trimmed[at] === "]") {
          depth -= 1;
          if (depth === 0) {
            at += 1;
            break;
          }
        }
      }
      rest = trimmed.slice(at);
      continue;
    }
    return trimmed;
  }
}

/** Header of an item as written, collapsed to one line. */
export function rustHeader(text: string, item: RustItem): string {
  const stop = item.bodyStart ?? item.end;
  const raw = text.slice(item.start, stop).replace(/;\s*$/, "");
  return stripLeadingAttributes(raw).replace(/\s+/g, " ").trim();
}

/** Doc comment (/// or //!) immediately above an item, joined by newlines. */
export function rustDoc(text: string, itemStart: number): string | undefined {
  const lines = text.slice(0, itemStart).split("\n");
  const collected: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line.startsWith("///") || line.startsWith("//!")) {
      collected.unshift(line.replace(/^\/\/[/!]\s?/, ""));
      continue;
    }
    if (line.startsWith("#[") || line.startsWith("#![") || line === "") continue;
    break;
  }
  const doc = collected.join("\n").trim();
  return doc === "" ? undefined : doc;
}

/** Brace body of an item, converted to byte offsets. */
export function rustBodySpan(
  item: RustItem,
  source: { toByte(offset: number): number; linesIn(start: number, end: number): number },
): BodySpan | undefined {
  if (item.bodyStart === undefined || item.bodyEnd === undefined) return undefined;
  const start = source.toByte(item.bodyStart);
  const end = source.toByte(item.bodyEnd);
  return { start, end, lines: source.linesIn(start, end), expression: false };
}

/** Modifiers written before the item keyword ('pub', 'async', 'unsafe'). */
export function rustModifiers(text: string, mask: Uint8Array, item: RustItem): string[] {
  const modifiers: string[] = [];
  let at = item.start;
  while (at < item.keywordStart) {
    const token = nextToken(text, mask, at);
    if (token.end <= token.start || token.start >= item.keywordStart) break;
    if (token.text === "pub" || token.text === "async" || token.text === "unsafe") modifiers.push(token.text);
    else if (token.text === "default" || token.text === "auto") modifiers.push(token.text);
    at = token.end;
  }
  return modifiers;
}

/** The name of an item as written ('Bot', 'load_file', 'impl Trait for X'). */
export function rustItemName(text: string, item: RustItem): string {
  if (item.keyword === "impl") return rustHeader(text, item);
  if (item.nameStart === undefined || item.nameEnd === undefined) return item.keyword;
  return text.slice(item.nameStart, item.nameEnd);
}

/** Items of a file, with the mask computed once. */
export function rustItems(text: string): { items: RustItem[]; mask: Uint8Array } {
  const mask = maskRust(text);
  return { items: parseItemsIn(text, mask), mask };
}

