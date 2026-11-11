/**
 * Rust profile (rust-analyzer).
 *
 * Three things differ from TypeScript, and all three were measured (see
 * docs/measurements.md):
 *
 * 1. rust-analyzer puts the resolved type/signature in documentSymbol.detail
 *    ('fn(&mut self, text: &str) -> Result<usize, StoreError>', 'u64'). Hover
 *    repeats the written header and adds qualifiers plus the doc comment, so
 *    detail is the source of truth for the signature and hover supplies the doc.
 * 2. It reports declarations, not statements: members of impl/trait blocks are
 *    nested under the block, and anything inside a function body is not a
 *    declaration of the module, so it is dropped here.
 * 3. Rust has no overloading, so signatureHelp is never consulted.
 */
import path from "node:path";
import { readdir } from "node:fs/promises";

import type { SourceText } from "../core/source-text.ts";
import { readTextOrUndefined } from "../lsp/documents.ts";
import type { ServerLaunchSpec, SessionSymbol } from "../lsp/session.ts";
import {
  innermostItem,
  maskRust,
  nextToken,
  parseItemsIn,
  rustBodySpan,
  rustDoc,
  rustHeader,
  rustItemName,
  rustModifiers,
  stripLeadingAttributes,
  type RustItem,
} from "../syntax/rust-syntax.ts";
import type { LanguageProfile } from "./profile.ts";
import type {
  BodySpan,
  ByteSpan,
  CallSiteCandidate,
  ClassifyFacts,
  DeclarationKind,
  GlobalSpan,
  ProfileDescription,
  RenderLayout,
  SymbolFacts,
} from "./types.ts";

/** LSP SymbolKind values, named so the mapping reads as data. */
const KIND = {
  Module: 2,
  Namespace: 3,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  EnumMember: 22,
  Struct: 23,
  // LSP 'Object'. Measured: rust-analyzer reports 'impl ...' blocks as either
  // Struct (23) or Object (19) depending on the block, never with a name of its
  // own, so the 'impl ' prefix is the only discriminator either way.
  Object: 19,
  TypeParameter: 26,
} as const;

/** Declarations drawn as a header, indented members, and a closing brace. */
// A Map, not an object: the declaration kind "constructor" would otherwise
// collide with Object.prototype.constructor on lookup.
const LAYOUTS = new Map<string, RenderLayout>([
  ["struct", "block"],
  ["union", "block"],
  ["enum", "block"],
  ["trait", "block"],
  ["impl", "block"],
  ["module", "block"],
]);

export const rustProfile: LanguageProfile = {
  id: "rust",
  servers: ["rust-analyzer"],
  extensions: [".rs"],
  keepsLocals: false,
  exportPrefix: "",
  // Measured: detail carries the resolved signature and doc comments are plain
  // text in the file, so hover would only add a round trip per symbol (and on
  // rust-analyzer 0.3.3105 it costs ~6.5s for a const).
  wantsHover: false,

  languageId(): string {
    return "rust";
  },

  serverSpec(resolveBin: (packageName: string, binName: string) => string): ServerLaunchSpec {
    void resolveBin;
    return {
      name: "rust-analyzer",
      // Measured: rust-analyzer speaks LSP over stdio and takes no arguments.
      command: resolveRustAnalyzer(),
      args: [],
      initializationOptions: {},
    };
  },

  async projectEntry(workspaceRoot: string): Promise<string | undefined> {
    // rust-analyzer builds a crate graph only once a file inside a Cargo
    // package is open, and only then does it report progress to wait on.
    if ((await readTextOrUndefined(path.join(workspaceRoot, "Cargo.toml"))) === undefined) return undefined;
    return firstRustSource(workspaceRoot);
  },

  async awaitWorkspaceReady(
    session: { documentSymbols(filePath: string): Promise<unknown[]> },
    entry: string,
    timeoutMs: number,
  ): Promise<boolean> {
    // Measured: rust-analyzer reports documentSymbol for a file as soon as it
    // has parsed it, and returns nothing while the crate graph is missing. Until
    // the graph exists, an empty answer is indistinguishable from "no symbols",
    // so the entry file is polled instead of trusting the first reply.
    const deadline = Date.now() + Math.min(timeoutMs, 15_000);
    for (;;) {
      const symbols = await session.documentSymbols(entry).catch(() => []);
      if (symbols.length > 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },

  classify({ source, symbol, parentKind }: ClassifyFacts): DeclarationKind | undefined {
    // A binding inside a function body is a statement, not a declaration of
    // the module: it never enters the skeleton (measured: rust-analyzer
    // nests nothing there, but the guard keeps other servers honest).
    if (parentKind !== undefined && isBodyKind(parentKind) && symbol.kind !== KIND.Module) {
      if (symbol.kind === KIND.Variable || symbol.kind === KIND.Constant || symbol.kind === KIND.Function) return undefined;
    }
    switch (symbol.kind) {
      case KIND.Function:
      case KIND.Method:
        return parentKind === undefined || parentKind === "module" ? "function" : "method";
      case KIND.Constructor:
        return "constructor";
      case KIND.Struct:
        // rust-analyzer reports `impl` blocks as Struct with an 'impl ' name,
        // which is the only reliable discriminator (measured: kind 23 for both
        // 'struct Word' and 'impl Word').
        return symbol.name.startsWith("impl ") ? "impl" : "struct";
      case KIND.Object:
        return symbol.name.startsWith("impl ") ? "impl" : "struct";
      case KIND.Class:
        return symbol.name.startsWith("impl ") ? "impl" : "class";
      case KIND.Enum:
        return "enum";
      case KIND.EnumMember:
        return "enum-member";
      case KIND.Interface:
        return "trait";
      case KIND.Module:
      case KIND.Namespace:
        return "module";
      case KIND.Constant:
      case KIND.Variable: {
        // Measured: rust-analyzer reports 'const' and 'static' both as
        // Constant (14), so the written keyword is the only way to tell them
        // apart.
        if (parentKind !== undefined) return "const";
        return itemOf(source, symbol)?.keyword === "static" ? "static" : "const";
      }
      case KIND.TypeParameter:
        return "type-alias";
      case KIND.Field:
      case KIND.Property:
        return "property";
      default:
        return "unknown";
    }
  },

  qualify({ symbol }: SymbolFacts, parentQualifiedName: string | undefined): string {
    if (parentQualifiedName === undefined) return symbol.name;
    // An impl block's own name is its written header ('impl Lookup for WordStore'),
    // which is what makes two impl blocks distinguishable in the tree. Its
    // members belong to the *type*, so they are named 'WordStore.find' — the
    // same shape a TypeScript class produces ('SessionStore.refresh').
    const owner = parentQualifiedName.startsWith("impl ")
      ? implReceiver(parentQualifiedName)
      : parentQualifiedName;
    return `${owner}.${symbol.name}`;
  },

  nameOffset({ symbol }: SymbolFacts): number {
    // Measured: selectionRange is the name itself for every mapped kind, which
    // is exactly the position hover and prepareCallHierarchy want.
    return symbol.selectionRange.start;
  },

  declarationStart({ symbol }: SymbolFacts): number {
    // documentSymbol already starts at the first attribute or doc comment (the
    // '#[tokio::main]' above main, the '///' above a const), and that is what
    // expand must return.
    return symbol.range.start;
  },

  body({ source, symbol, kind }: SymbolFacts): BodySpan | undefined {
    if (kind === "enum-member" || kind === "property" || kind === "type-alias" || kind === "const" || kind === "static") return undefined;
    const item = itemOf(source, symbol);
    if (item === undefined) return undefined;
    return rustBodySpan(item, source);
  },

  exported({ source, symbol }: SymbolFacts): boolean {
    const item = itemOf(source, symbol);
    if (item === undefined) return false;
    return rustModifiers(source.text, maskRust(source.text), item).includes("pub");
  },

  emptyFileExplanation:
    "That can mean an empty file, a file outside the Cargo package (src/ of a crate with Cargo.toml), or a server that has not finished loading.",

  isStdlibPath(filePath: string): boolean {
    // Measured: rust-analyzer answers std/core/alloc items with paths inside the
    // toolchain's rust-src tree, not with anything under the workspace.
    return /(?:^|\/)library\/(?:core|std|alloc|proc_macro|test)\/src\//.test(filePath) || /\/rustlib\/src\/rust\//.test(filePath);
  },

  isExternalPath(filePath: string): boolean {
    // Anything outside the workspace is a dependency: the cargo registry, the
    // toolchain's sources, or a path that escaped the root with '..'.
    return filePath.startsWith("..") || filePath.includes("/registry/src/") || this.isStdlibPath(filePath);
  },

  stdlibNote(count: number): string {
    return `${count} call(s) into the Rust standard library (std/core/alloc) were omitted as out of scope for deps.`;
  },

  heritage({ source, symbol, kind }: SymbolFacts): string | undefined {
    if (kind !== "trait") return undefined;
    const item = itemOf(source, symbol);
    if (item === undefined) return undefined;
    const header = rustHeader(source.text, item);
    // 'pub trait Lookup: Send + Sync' -> ': Send + Sync'
    const colon = header.indexOf(":");
    if (colon < 0) return undefined;
    const bounds = header.slice(colon + 1).split(" where ")[0]?.trim();
    return bounds === undefined || bounds === "" ? undefined : `: ${bounds}`;
  },

  parameterName({ source, symbol }: SymbolFacts): string | undefined {
    const item = itemOf(source, symbol);
    if (item === undefined) return undefined;
    const header = rustHeader(source.text, item);
    const open = header.indexOf("(");
    if (open < 0) return undefined;
    const first = (header.slice(open + 1).split(",")[0] ?? "").trim();
    const colon = first.indexOf(":");
    return colon < 0 ? undefined : first.slice(0, colon).replace(/^mut\s+/, "").trim();
  },

  describe({ source, symbol, kind }: SymbolFacts, hover: string | undefined): ProfileDescription {
    const item = itemOf(source, symbol);
    const header = item === undefined ? undefined : rustHeader(source.text, item);
    const modifiers = item === undefined ? [] : rustModifiers(source.text, maskRust(source.text), item);
    const parsed = hover === undefined ? undefined : parseRustHover(hover);
    const detail = symbol.detail?.trim();
    // Rust doc comments are ordinary comments in the file, so they can be read
    // without the server. Measured: under load rust-analyzer occasionally
    // answers hover with nothing at all, and the doc must not disappear with it.
    const doc = parsed?.doc ?? (item === undefined ? undefined : rustDoc(source.text, item.start));
    // Rust has no overloading: a call site never selects a different signature.
    const withDoc = (signature: string, from: "checker" | "source"): ProfileDescription => ({
      signature: { signature, source: from },
      ...(doc === undefined ? {} : { doc }),
      overloads: 0,
    });

    // Measured: hover on an enum variant returns nothing at all, and detail is
    // empty, so the variant's own text is the only description there is:
    // 'Fuzzy { max_distance: u8 }' or 'Duplicate(String)'.
    if (kind === "enum-member") {
      // The reported range starts at the variant's own doc comment, which is
      // not part of the declaration itself.
      const written = source.slice(symbol.range.start, symbol.range.end);
      return withDoc(oneLine(stripLeadingAttributes(written)), "source");
    }
    if (detail !== undefined && detail !== "" && carriesSignature(kind, symbol, parentIsImpl(symbol, source))) {
      return withDoc(composeFromDetail({ kind, detail, header, modifiers, symbol }), "checker");
    }
    if (header !== undefined && header !== "") return withDoc(header, "source");
    if (detail !== undefined && detail !== "") return withDoc(`${symbol.name}: ${detail}`, "checker");
    if (parsed?.signature !== undefined && parsed.signature !== "") return withDoc(parsed.signature, "checker");
    return withDoc(symbol.name, "source");
  },

  layout(kind: DeclarationKind, node: { body?: unknown; children: unknown[] }): RenderLayout {
    const declared = LAYOUTS.get(kind);
    if (declared === undefined) return "line";
    // Nothing to fold and nothing to nest, so the header is the whole item:
    // `pub struct WordPair(pub Word, pub Word);`, `mod models;`, an empty enum.
    return node.body === undefined && node.children.length === 0 ? "line" : declared;
  },

  renderGlobal(filePath: string, text: string): string[] {
    return renderRustGlobal(filePath, text);
  },

  globals({ source, covered }): GlobalSpan[] {
    const text = source.text;
    const mask = maskRust(text);
    const spans: GlobalSpan[] = [];
    for (const item of parseItemsIn(text, mask)) {
      if (item.depth !== 0) continue;
      const start = source.toByte(item.start);
      const end = source.toByte(item.end);
      const overlaps = covered.some((range) => range.start < end && start < range.end);
      if (overlaps) continue;
      spans.push({ range: { start, end }, lines: source.linesIn(start, end) });
    }
    return spans;
  },

  resolution: {
    signatureHelp: false,
    directCallSites(filePath: string, source: SourceText, body: ByteSpan): CallSiteCandidate[] {
      return rustCallSites(filePath, source, body);
    },
  },
};

// ------------------------------------------------------------------ helpers

function isBodyKind(kind: DeclarationKind): boolean {
  return kind === "function" || kind === "method" || kind === "constructor";
}

/**
 * Whether the 'pub' in front of a declaration is worth printing.
 *
 * A struct field arrives as its own documentSymbol without being an item of its
 * own, so the modifier scan finds no 'pub' and the written header already
 * carries it. Printing both would duplicate the keyword.
 */
function showsVisibility(kind: DeclarationKind): boolean {
  return (
    kind === "function" ||
    kind === "method" ||
    kind === "constructor" ||
    kind === "const" ||
    kind === "static" ||
    kind === "type-alias" ||
    kind === "struct" ||
    kind === "union" ||
    kind === "trait" ||
    kind === "enum" ||
    kind === "module"
  );
}

/**
 * The scanner item that declares this symbol, if the scanner has one.
 *
 * Located by the *name* offset, not by range.start: measured on the fixture,
 * rust-analyzer reports a range that begins at the blank line before a doc
 * comment (offset 170 for a declaration whose attributes start at 197), which
 * is trivia the scanner skips. selectionRange always points inside the item.
 *
 * The name has to match as well. Struct fields and enum variants are symbols
 * the scanner does not parse on their own, so the innermost item around them is
 * the enclosing struct or enum; returning that header would print the parent's
 * declaration once per member.
 */
function itemOf(source: SourceText, symbol: SessionSymbol): RustItem | undefined {
  const text = source.text;
  const mask = maskRust(text);
  const item =
    innermostItem(text, mask, source.toUtf16(symbol.selectionRange.start)) ??
    innermostItem(text, mask, source.toUtf16(symbol.range.start));
  if (item === undefined) return undefined;
  return normalize(rustItemName(text, item)) === normalize(symbol.name) ? item : undefined;
}

/**
 * The type an impl block implements for: 'impl Lookup for WordStore' -> 'WordStore'.
 *
 * The last segment after ' for ' wins; without one the block implements the
 * type itself ('impl Room' -> 'Room'). Generic parameters are dropped so the
 * qualified name stays readable and matches the declaration it belongs to.
 */
function implReceiver(header: string): string {
  const body = header.replace(/^impl\s*/, "").replace(/^<[^>]*>\s*/, "");
  const forIndex = body.lastIndexOf(" for ");
  const target = (forIndex < 0 ? body : body.slice(forIndex + 5)).trim();
  const bare = target.replace(/^&\s*(?:'\w+\s+)?/, "").replace(/<.*$/, "").trim();
  return bare === "" ? header : bare;
}

/** Collapse whitespace so a written header and a server-reported name compare. */
function normalize(text: string): string {
  return oneLine(text);
}

/** Collapse a possibly multi-line declaration to a single line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when the owning item is an impl block (members inherit its type). */
function parentIsImpl(symbol: SessionSymbol, source: SourceText): boolean {
  const text = source.text;
  const mask = maskRust(text);
  const item = innermostItem(text, mask, source.toUtf16(symbol.range.start));
  return item?.keyword === "impl" || item?.keyword === "trait";
}

/** Item kinds whose detail is the resolved signature. */
function carriesSignature(kind: DeclarationKind, symbol: SessionSymbol, inImpl: boolean): boolean {
  if (kind === "function" || kind === "method" || kind === "constructor") return true;
  if (kind === "const" || kind === "static" || kind === "type-alias" || kind === "module" || kind === "property") return true;
  // A macro_rules! item arrives as an unnamed Function; it has no signature.
  if (kind === "unknown") return false;
  void symbol;
  void inImpl;
  return false;
}

/**
 * Build the one-line signature from detail plus the facts only the source has.
 *
 * detail is 'fn(&mut self, text: &str) -> Result<usize, StoreError>', 'u64' or
 * 'Result<T, MessengerError>'. It never repeats the item's name, the 'pub'
 * modifier or 'async', and for constants it drops the value.
 */
function composeFromDetail(input: {
  kind: DeclarationKind;
  detail: string;
  header: string | undefined;
  modifiers: string[];
  symbol: SessionSymbol;
}): string {
  const { kind, detail, header, modifiers, symbol } = input;
  const visibility = modifiers.includes("pub") && showsVisibility(kind) ? "pub " : "";
  if (kind === "function" || kind === "method" || kind === "constructor") {
    const asyncPrefix = modifiers.includes("async") ? "async " : "";
    const name = `${symbol.name}${genericSuffix(header, symbol.name)}`;
    // 'fn(...)' -> 'name(...)': keep parameters and return type verbatim.
    const rest = detail.replace(/^(?:pub(?:\s*\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s*/, "");
    return `${visibility}${asyncPrefix}fn ${name}${rest}`;
  }
  if (kind === "module") return `${visibility}mod ${symbol.name}`;
  if (kind === "const" || kind === "static") {
    const keyword = kind === "static" ? "static" : "const";
    const value = constantValue(header);
    return `${visibility}${keyword} ${symbol.name}: ${detail}${value === undefined ? "" : ` = ${value}`}`;
  }
  if (kind === "type-alias") {
    return `${visibility}type ${symbol.name}${genericSuffix(header, symbol.name)} = ${detail}`;
  }
  if (kind === "property") return `${visibility}${symbol.name}: ${detail}`;
  return detail;
}

/** '<T>' (or '<T, E>') of a declaration header, when it has one. */
function genericSuffix(header: string | undefined, name: string): string {
  if (header === undefined) return "";
  const index = header.indexOf(`${name}<`);
  if (index < 0) return "";
  const start = index + name.length;
  let depth = 0;
  for (let at = start; at < header.length; at += 1) {
    if (header[at] === "<") depth += 1;
    else if (header[at] === ">") {
      depth -= 1;
      if (depth === 0) return header.slice(start, at + 1);
    }
  }
  return "";
}

/** The initialiser expression of a const/static, when it fits on one line. */
function constantValue(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const index = header.indexOf(" = ");
  return index < 0 ? undefined : header.slice(index + 3).trim();
}

/**
 * The pieces of a rust-analyzer hover we use.
 *
 * Format (measured): optional crate fence, the declaration fence, then sections
 * separated by '---': layout facts ('size = ...'), 'Is dyn-compatible', and the
 * doc comment.
 */
export function parseRustHover(markdown: string): { signature?: string; doc?: string } | undefined {
  const fences = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => (match[1] ?? "").trim());
  if (fences.length === 0) return undefined;
  // The last fence is the declaration; earlier ones qualify crate/module.
  const signature = fences[fences.length - 1];
  const afterLast = markdown.slice(markdown.lastIndexOf("```") + 3);
  const sections = afterLast
    .split(/\n---\n/)
    .map((section) => section.trim())
    .filter((section) => section !== "" && !isLayoutSection(section));
  const doc = sections.join("\n\n").trim();
  return {
    ...(signature === undefined || signature === "" ? {} : { signature: collapse(signature) }),
    ...(doc === "" ? {} : { doc }),
  };
}

function isLayoutSection(section: string): boolean {
  return /^size = \d+/.test(section) || section === "Is dyn-compatible";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render one uncovered top-level region.
 *
 * A 'use' clause is printed as written, with a multi-line brace group
 * re-indented so it reads as one statement. rust-analyzer does not report 'use'
 * as a symbol, so this is the only path that puts imports in the skeleton.
 */
export function renderRustGlobal(filePath: string, text: string): string[] {
  void filePath;
  const lines = text.trimEnd().split("\n").map((line) => line.trimEnd());
  if (!/^\s*use\b/.test(lines[0] ?? "")) return lines;
  return lines.map((line, index) => (index === 0 ? line : `  ${line.trim()}`));
}

/** Call-site candidates inside a Rust body (macro invocations included). */
function rustCallSites(filePath: string, source: SourceText, body: ByteSpan): CallSiteCandidate[] {
  void filePath;
  const text = source.text;
  const mask = maskRust(text);
  const start = source.toUtf16(body.start);
  const end = source.toUtf16(body.end);
  const sites: CallSiteCandidate[] = [];
  let at = start;
  while (at < end) {
    if (mask[at] === 0) {
      at += 1;
      continue;
    }
    const char = text[at] ?? "";
    // A call is an identifier or path immediately followed by '('.
    if (!/[A-Za-z_]/.test(char) || /[A-Za-z0-9_]/.test(text[at - 1] ?? "")) {
      at += 1;
      continue;
    }
    const tokenStart = at;
    let cursor = at;
    while (cursor < end && mask[cursor] === 1 && /[A-Za-z0-9_:]/.test(text[cursor] ?? "")) cursor += 1;
    const after = nextToken(text, mask, cursor);
    if (after.text === "(") {
      const byteStart = source.toByte(tokenStart);
      sites.push({
        calleeStart: byteStart,
        calleeEnd: source.toByte(cursor),
        callStart: byteStart,
        callEnd: source.toByte(matchClose(text, mask, after.start, "(", ")")),
        calleeText: text.slice(tokenStart, cursor),
        isNew: false,
        line: source.lineAt(byteStart),
      });
    }
    at = Math.max(cursor, at + 1);
  }
  return sites;
}

function matchClose(text: string, mask: Uint8Array, openAt: number, open: string, close: string): number {
  let depth = 0;
  for (let at = openAt; at < text.length; at += 1) {
    if (mask[at] !== 1) continue;
    if (text[at] === open) depth += 1;
    else if (text[at] === close) {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return text.length;
}

/** The file that makes rust-analyzer build the crate graph for a workspace. */
async function firstRustSource(workspaceRoot: string): Promise<string> {
  for (const candidate of ["src/main.rs", "src/lib.rs"]) {
    const file = path.join(workspaceRoot, candidate);
    if ((await readTextOrUndefined(file)) !== undefined) return file;
  }
  const entries = await readdir(path.join(workspaceRoot, "src"), { withFileTypes: true }).catch(() => []);
  const first = entries.find((entry) => entry.isFile() && entry.name.endsWith(".rs"));
  return first === undefined ? path.join(workspaceRoot, "src", "main.rs") : path.join(workspaceRoot, "src", first.name);
}

/**
 * Locate the rust-analyzer executable.
 *
 * Measured: a rustup-installed 'rust-analyzer' on PATH is a proxy that exits
 * with 'Unknown binary rust-analyzer in official toolchain', so the override
 * exists to point at a real binary (the VS Code extension's server, a mason
 * package, or a rustup component install).
 */
export function resolveRustAnalyzer(): string {
  return process.env.LSP_SKELETON_RUST_ANALYZER ?? "rust-analyzer";
}