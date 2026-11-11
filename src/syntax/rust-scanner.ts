/**
 * Just enough Rust syntax to answer the questions the query layer asks.
 *
 * The TypeScript parser cannot be pointed at Rust: it splits a 'use' clause
 * into separate statements and loses item boundaries, which is where the
 * fragmented 'use' rendering and the missing text in the before-fixture came
 * from. This module is a scanner, not a compiler: it masks comments and
 * string/char literals, then walks braces to find item boundaries.
 *
 * Ranges handed in by callers are byte offsets. Offsets returned from the
 * scanner are UTF-16 (the unit JS strings use); the profile converts them.
 */

/** Keywords that can start an item. */
const ITEM_KEYWORDS = new Set([
  "fn",
  "struct",
  "enum",
  "trait",
  "impl",
  "mod",
  "union",
  "type",
  "static",
  "const",
  "use",
  "extern",
  "macro_rules",
]);

const BLOCK_KEYWORDS = new Set(["fn", "impl", "trait", "struct", "enum", "union", "mod", "extern", "macro_rules"]);

/** Keywords that are modifiers when they precede an item keyword. */
const MODIFIER_KEYWORDS = new Set(["pub", "async", "unsafe", "default", "auto", "extern", "const"]);

/** Items whose bodies hold more items. */
const CONTAINER_KEYWORDS = new Set(["impl", "trait", "mod", "extern"]);

/** Mask comments and literals: 1 = code, 0 = comment/literal (per UTF-16 index). */
export function maskRust(text: string): Uint8Array {
  const mask = new Uint8Array(text.length).fill(1);
  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < mask.length; at += 1) if (text.charCodeAt(at) !== 10) mask[at] = 0;
  };
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      let depth = 1;
      let at = index + 2;
      while (at < text.length && depth > 0) {
        if (text[at] === "/" && text[at + 1] === "*") {
          depth += 1;
          at += 2;
        } else if (text[at] === "*" && text[at + 1] === "/") {
          depth -= 1;
          at += 2;
        } else {
          at += 1;
        }
      }
      blank(index, at);
      index = at;
      continue;
    }
    if (char === "r" && (next === '"' || next === "#")) {
      let hashes = 0;
      let at = index + 1;
      while (text[at] === "#") {
        hashes += 1;
        at += 1;
      }
      if (text[at] === '"') {
        const terminator = '"' + "#".repeat(hashes);
        const end = text.indexOf(terminator, at + 1);
        const stop = end < 0 ? text.length : end + terminator.length;
        blank(index, stop);
        index = stop;
        continue;
      }
    }
    if ((char === "b" || char === "c") && next === '"') {
      const end = scanQuoted(text, index + 1);
      blank(index, end);
      index = end;
      continue;
    }
    if (char === '"') {
      const end = scanQuoted(text, index);
      blank(index, end);
      index = end;
      continue;
    }
    if (char === "'") {
      const end = scanCharLiteral(text, index);
      if (end > index) {
        blank(index, end);
        index = end;
        continue;
      }
    }
    index += 1;
  }
  return mask;
}

function scanQuoted(text: string, quoteAt: number): number {
  let at = quoteAt + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char === '"') return at + 1;
    at += 1;
  }
  return text.length;
}

/** End of a char literal, or -1 when the quote starts a lifetime or an error. */
function scanCharLiteral(text: string, quoteAt: number): number {
  const at = quoteAt + 1;
  if (text[at] === "\\") {
    const escaped = at + 2;
    return text[escaped] === "'" ? escaped + 1 : -1;
  }
  if (text[at + 1] === "'" && text[at] !== "'") return at + 2;
  return -1;
}

function skipTrivia(text: string, mask: Uint8Array, from: number): number {
  let at = from;
  while (at < text.length) {
    if (mask[at] === 0) {
      at += 1;
      continue;
    }
    const char = text[at];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      at += 1;
      continue;
    }
    break;
  }
  return at;
}

/** Skip attributes (#[...]) and doc comments before an item. */
function skipAttributes(text: string, mask: Uint8Array, from: number): number {
  let at = from;
  for (;;) {
    at = skipTrivia(text, mask, at);
    if (text[at] !== "#") return at;
    let cursor = at + 1;
    if (text[cursor] === "!") cursor += 1;
    if (text[cursor] !== "[") return at;
    let depth = 0;
    while (cursor < text.length) {
      if (mask[cursor] === 1) {
        if (text[cursor] === "[") depth += 1;
        else if (text[cursor] === "]") {
          depth -= 1;
          if (depth === 0) {
            cursor += 1;
            break;
          }
        }
      }
      cursor += 1;
    }
    at = cursor;
  }
}

const PAIRS = ["=>", "->", "::", ".."];

export interface RustToken {
  text: string;
  start: number;
  end: number;
}

export function nextToken(text: string, mask: Uint8Array, from: number): RustToken {
  const start = skipTrivia(text, mask, from);
  for (const pair of PAIRS) {
    if (text.startsWith(pair, start)) return { text: pair, start, end: start + pair.length };
  }
  const char = text[start] ?? "";
  if (/[A-Za-z0-9_]/.test(char)) {
    let at = start;
    while (at < text.length && mask[at] === 1 && /[A-Za-z0-9_]/.test(text[at] ?? "")) at += 1;
    return { text: text.slice(start, at), start, end: at };
  }
  return { text: char, start, end: start + 1 };
}

export interface RustItem {
  /** Keyword that identified the item (fn, struct, use, ...). */
  keyword: string;
  /** UTF-16 offset of the item keyword (attributes and docs excluded). */
  keywordStart: number;
  /** UTF-16 offset of the first attribute or doc line (where the item starts). */
  start: number;
  /** UTF-16 offset just past the item. */
  end: number;
  /** UTF-16 offsets of the item's own name, when it has one. */
  nameStart?: number;
  nameEnd?: number;
  /** UTF-16 offsets of the item's brace body, when it has one. */
  bodyStart?: number;
  bodyEnd?: number;
  /** Depth in the nesting (0 = file level, 1 = impl/trait member, ...). */
  depth: number;
}

/** Consume a balanced group starting at openAt; returns the offset past it. */
function matchGroup(text: string, mask: Uint8Array, openAt: number, open: string, close: string): number {
  let depth = 0;
  let at = openAt;
  while (at < text.length) {
    if (mask[at] === 1) {
      if (text[at] === open) depth += 1;
      else if (text[at] === close) {
        depth -= 1;
        if (depth === 0) return at + 1;
      }
    }
    at += 1;
  }
  return text.length;
}

/** Parse one item starting at or after 'from', or undefined if none starts. */
export function parseItem(text: string, mask: Uint8Array, from: number, depth = 0): RustItem | undefined {
  const attributeStart = skipTrivia(text, mask, attributeStartLoop(text, mask, from));
  const afterAttributes = skipAttributes(text, mask, attributeStart);
  // Modifiers may precede the keyword ('pub', 'async', 'unsafe', 'extern').
  let keywordToken = nextToken(text, mask, afterAttributes);
  let guard = 0;
  while (MODIFIER_KEYWORDS.has(keywordToken.text) && guard < 8) {
    const after = nextToken(text, mask, keywordToken.end);
    // 'const' is a keyword when it names an item ('const NAME:'), a modifier
    // when it modifies a function ('const fn').
    if (keywordToken.text === "const" && after.text !== "fn" && after.text !== "unsafe" && after.text !== "async") break;
    keywordToken = after;
    guard += 1;
  }
  if (keywordToken.text === "" || !ITEM_KEYWORDS.has(keywordToken.text)) return undefined;
  const keyword = keywordToken.text;
  const item: RustItem = {
    keyword,
    keywordStart: keywordToken.start,
    start: attributeStart,
    end: text.length,
    depth,
  };

  // Name of the item. 'impl' has a header rather than a name; 'use' has none.
  if (keyword !== "impl" && keyword !== "use") {
    let nameToken = nextToken(text, mask, keywordToken.end);
    if (nameToken.text === "<") nameToken = nextToken(text, mask, matchGroup(text, mask, nameToken.start, "<", ">"));
    if (keyword === "macro_rules") {
      const bang = nextToken(text, mask, nameToken.end);
      nameToken = nextToken(text, mask, bang.text === "!" ? bang.end : nameToken.end);
    }
    if (/^[A-Za-z_]/.test(nameToken.text)) {
      item.nameStart = nameToken.start;
      item.nameEnd = nameToken.end;
    }
  }

  // End of the item: its brace body when it has one, else the next semicolon.
  let scan = keywordToken.end;
  let bodyStart: number | undefined;
  while (scan < text.length) {
    const token = nextToken(text, mask, scan);
    if (token.end <= scan) break;
    if (token.text === "{") {
      bodyStart = token.start;
      break;
    }
    if (token.text === ";" || token.text === "}" || token.text === "") break;
    scan = token.end;
  }
  if (bodyStart !== undefined && BLOCK_KEYWORDS.has(keyword)) {
    item.bodyStart = bodyStart;
    item.bodyEnd = matchGroup(text, mask, bodyStart, "{", "}");
    item.end = item.bodyEnd;
  } else {
    const stop = text.indexOf(";", bodyStart ?? keywordToken.end);
    item.end = stop < 0 ? text.length : stop + 1;
  }
  return item;
}

/** Skip whitespace only (attributes are handled by skipAttributes). */
function attributeStartLoop(text: string, mask: Uint8Array, from: number): number {
  return from;
}

/** All items in [from, to), recursing into impl/trait/mod bodies. */
export function parseItemsIn(text: string, mask: Uint8Array, from = 0, to = text.length, depth = 0): RustItem[] {
  const items: RustItem[] = [];
  let at = from;
  while (at < to) {
    const item = parseItem(text, mask, at, depth);
    if (item === undefined) {
      const newline = text.indexOf("\n", at);
      at = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (item.start > to) break;
    items.push(item);
    if (CONTAINER_KEYWORDS.has(item.keyword) && item.bodyStart !== undefined && item.bodyEnd !== undefined) {
      items.push(...parseItemsIn(text, mask, item.bodyStart + 1, item.bodyEnd - 1, depth + 1));
    }
    at = Math.max(item.end, at + 1);
  }
  return items;
}

/** All top-level items of a Rust file, in source order (no recursion). */
export function parseTopLevelItems(text: string, mask = maskRust(text)): RustItem[] {
  return parseItemsIn(text, mask).filter((item) => item.depth === 0);
}

/** The innermost item that contains a UTF-16 offset. */
export function innermostItem(text: string, mask: Uint8Array, offset: number): RustItem | undefined {
  let best: RustItem | undefined;
  for (const item of parseItemsIn(text, mask)) {
    if (item.start <= offset && offset < item.end) {
      if (best === undefined || item.depth > best.depth) best = item;
      else if (best.depth === item.depth && item.end - item.start < best.end - best.start) best = item;
    }
  }
  return best;
}

