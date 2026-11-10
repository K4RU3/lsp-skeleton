/**
 * Turns `documentSymbol` output into the symbol model the rest of the query
 * layer uses: qualified names, checker-resolved signatures, folded bodies.
 *
 * This is deliberately the *only* place that builds symbol identity. skeleton,
 * deps, expand, usages and search all consume the same nodes.
 */
import { SymbolKind as LspSymbolKind } from "../lsp/protocol.ts";
import type { SessionSymbol } from "../lsp/session.ts";
import type { LspSession } from "../lsp/session.ts";
import {
  bodyOf,
  classifyDeclaration,
  signatureHeader,
  topLevelStatements,
  declarationStart,
  declarationNameOffset,
  heritageText,
  isExported,
  parameterNames,
  type DeclarationKind,
} from "../syntax/ts-syntax.ts";
import { parseHover, stripReceiver } from "./hover-text.ts";
import { formatFunctionId } from "./ids.ts";

export interface SymbolNode {
  /** Canonical id: `relativePath#qualifiedName@hash6`. */
  id: string;
  /** Workspace-relative path with POSIX separators. */
  path: string;
  name: string;
  qualifiedName: string;
  kind: DeclarationKind;
  /** Checker-resolved signature (fallback: the source header). */
  signature: string;
  /**
   * Where the signature came from. `checker` is the normal case; `source`
   * means the LSP surface could not describe it faithfully (overload
   * implementations, setters) and the written header was used instead.
   */
  signatureSource: "checker" | "source";
  doc?: string;
  /** Byte range of the whole declaration. */
  range: { start: number; end: number };
  /** Byte range of the declaration's name (the identifier). */
  selectionRange: { start: number; end: number };
  /**
   * Byte offset of the name the server will recognise.
   *
   * `documentSymbol` reports the whole declaration as `selectionRange` for
   * overload implementations, and LSP would then resolve no symbol at that
   * position; this offset always points at the identifier itself.
   */
  nameOffset: number;
  /** Byte range of the body, when the declaration has one. */
  body?: { start: number; end: number; lines: number; expression: boolean };
  children: SymbolNode[];
  exported: boolean;
  /** Class/interface heritage, already rendered (`extends A implements B`). */
  heritage?: string;
  /** First parameter name (setters need it to render `set x(value: T)`). */
  parameterName?: string;
  /** Symbol kind as reported by the server (kept for adapters/filters). */
  lspKind: number;
}

export interface DocumentSkeleton {
  path: string;
  text: string;
  symbols: SymbolNode[];
  /** Top-level statements that are not part of any symbol (imports, globals). */
  globals: Array<{ range: { start: number; end: number }; lines: number }>;
}

const FUNCTION_KINDS = new Set<number>([
  LspSymbolKind.Function,
  LspSymbolKind.Method,
  LspSymbolKind.Constructor,
]);

/** Build the symbol tree for one file. */
export async function buildSymbolTree(session: LspSession, filePath: string): Promise<DocumentSkeleton> {
  const relativePath = pathOf(session, filePath);
  const document = await session.openDocument(filePath);
  const text = document.lines.text;
  const raw = await session.documentSymbols(filePath);
  const symbols = await Promise.all(
    raw.map((symbol) => convertSymbol(session, relativePath, text, symbol, undefined)),
  );
  const globals = collectGlobals(relativePath, text, symbols);
  return { path: relativePath, text, symbols, globals };
}

function pathOf(session: LspSession, filePath: string): string {
  return session.relativePath(session.resolvePath(filePath));
}

async function convertSymbol(
  session: LspSession,
  path: string,
  text: string,
  symbol: SessionSymbol,
  parent: SymbolNode | undefined,
): Promise<SymbolNode> {
  const nameOffset = declarationNameOffset(path, text, symbol.range, symbol.name);
  const kind = classifyDeclaration(path, text, symbol.range, "other");
  const qualifiedName = parent === undefined ? symbol.name : `${parent.qualifiedName}.${symbol.name}`;
  const isClassOrInterface = kind === "class" || kind === "interface";

  const resolved = await resolveSignature(session, path, text, symbol, nameOffset, kind);
  const range = { start: declarationStart(path, text, symbol.range), end: symbol.range.end };
  const children: SymbolNode[] = [];
  const node: SymbolNode = {
    id: formatFunctionId(path, qualifiedName, resolved.signature, kind),
    path,
    name: symbol.name,
    qualifiedName,
    kind,
    signature: resolved.signature,
    signatureSource: resolved.source,
    range,
    selectionRange: symbol.selectionRange,
    nameOffset,
    children,
    exported: isExported(path, text, symbol.range),
    lspKind: symbol.kind,
  };
  const hover = await session.hover(path, nameOffset);
  const parsed = hover === undefined ? undefined : parseHover(hover.markdown);
  if (parsed?.doc !== undefined) node.doc = parsed.doc;
  if (isClassOrInterface) {
    const heritage = heritageText(path, text, symbol.range);
    if (heritage !== undefined) node.heritage = heritage;
  }
  const body = bodyOf(path, text, symbol.range);
  if (body !== undefined) node.body = body;
  if (kind === "setter") {
    const parameters = parameterNames(path, text, symbol.range);
    const first = parameters[0];
    if (first !== undefined) node.parameterName = first;
  }
  for (const child of symbol.children) {
    children.push(await convertSymbol(session, path, text, child, node));
  }
  return node;
}

async function resolveSignature(
  session: LspSession,
  path: string,
  text: string,
  symbol: SessionSymbol,
  nameOffset: number,
  kind: DeclarationKind,
): Promise<{ signature: string; source: "checker" | "source" }> {
  const hover = await session.hover(path, nameOffset);
  const parsed = hover === undefined ? undefined : parseHover(hover.markdown);
  const header = normalizeHeader(signatureHeader(path, text, symbol.range));
  if (kind === "setter" || kind === "getter" || kind === "constructor") {
    // Hover renders accessors by their property type (a setter loses its
    // parameter) and constructors with a redundant return type, so the
    // written header is the faithful signature for these three kinds.
    if (header !== undefined) return { signature: header, source: "source" };
  }
  if (parsed !== undefined && parsed.overloads > 0 && header !== undefined && hasBody(path, text, symbol.range)) {
    // For an overload *implementation*, hover reports the first overload
    // again (`(+N overloads)`), not the implementation's own signature.
    // The annotated header is the only faithful description of it.
    if (header.includes("):") || header.includes("): ")) return { signature: header, source: "source" };
  }
  if (parsed !== undefined) {
    if (kind === "type-alias" || kind === "enum") return { signature: parsed.signature, source: "checker" };
    if (parsed.signature !== "") return { signature: stripReceiver(parsed.signature, symbol.name), source: "checker" };
  }
  // Fall back to the declaration's own header text (never to the body).
  const source = header ?? normalizeHeader(fallbackHeader(text, symbol, nameOffset));
  return { signature: source === undefined || source === "" ? symbol.name : source, source: "source" };
}

/** Collapse whitespace and drop modifiers the skeleton re-adds itself. */
function normalizeHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const normalized = header.replace(/\s+/g, " ").replace(/^export\s+/, "").replace(/^declare\s+/, "").trim();
  return normalized === "" ? undefined : normalized;
}

function fallbackHeader(text: string, symbol: SessionSymbol, nameOffset: number): string {
  const before = text.slice(symbol.range.start, nameOffset);
  const afterName = text.slice(nameOffset, symbol.range.end);
  const headerEnd = afterName.search(/[{(=]/);
  return (before + (headerEnd < 0 ? afterName : afterName.slice(0, headerEnd))).trim();
}

function hasBody(path: string, text: string, range: { start: number; end: number }): boolean {
  return bodyOf(path, text, range) !== undefined;
}

/**
 * Top-level statements that no symbol covers: imports and global statements.
 *
 * Working per *statement* (rather than per character gap) keeps partial
 * declarations such as `const store = ...` from being split in two.
 */
function collectGlobals(
  path: string,
  text: string,
  symbols: SymbolNode[],
): Array<{ range: { start: number; end: number }; lines: number }> {
  const covered = flatten(symbols).map((symbol) => symbol.range);
  const globals: Array<{ range: { start: number; end: number }; lines: number }> = [];
  for (const statement of topLevelStatements(path, text)) {
    const overlaps = covered.some((range) => range.start < statement.end && statement.start < range.end);
    if (overlaps) continue;
    globals.push({
      range: { start: statement.start, end: statement.end },
      lines: countLinesIn(text, statement.start, statement.end),
    });
  }
  return globals;
}

function countLinesIn(text: string, start: number, end: number): number {
  if (end <= start) return 0;
  let lines = 1;
  for (let index = start; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/**
 * Convert just the symbol that contains `offset` in one file.
 *
 * Used when following a dependency into another file (often a .d.ts in
 * node_modules): building the whole tree there would cost one hover per
 * symbol, while this costs one documentSymbol + one hover.
 */
export async function symbolAtOffset(
  session: LspSession,
  filePath: string,
  offset: number,
): Promise<SymbolNode | undefined> {
  const relativePath = session.relativePath(session.resolvePath(filePath));
  const document = await session.openDocument(filePath);
  const text = document.lines.text;
  const raw = await session.documentSymbols(filePath);
  const chain = findSymbolChain(raw, offset);
  if (chain.length === 0) return undefined;
  let parent: SymbolNode | undefined;
  for (const symbol of chain) {
    const converted = await convertSymbol(session, relativePath, text, symbol, parent);
    parent = converted;
  }
  return parent;
}

/** Symbols from the outermost to the innermost containing `offset`. */
function findSymbolChain(symbols: SessionSymbol[], offset: number): SessionSymbol[] {
  for (const symbol of symbols) {
    if (offset < symbol.range.start || offset > symbol.range.end) continue;
    const inner = findSymbolChain(symbol.children, offset);
    return [symbol, ...inner];
  }
  return [];
}

/** Name offset of a symbol in its file; used for hover-based signature lookup. */
export function selectionOffsetOf(node: SymbolNode): number {
  return node.selectionRange.start;
}

/** Flatten a tree in document order. */
export function flatten(nodes: SymbolNode[]): SymbolNode[] {
  const result: SymbolNode[] = [];
  const visit = (list: SymbolNode[]): void => {
    for (const node of list) {
      result.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return result;
}

/**
 * Find a symbol by id, exact qualified name, or bare name.
 *
 * A bare name can match several declarations (overloads: the signatures have
 * no body, the implementation does). Prefer the one with a body so that
 * `deps("parse")` scans the implementation instead of an empty signature.
 */
export function findSymbol(nodes: SymbolNode[], selector: string): SymbolNode | undefined {
  const all = flatten(nodes);
  const byId = all.find((node) => node.id === selector);
  if (byId !== undefined) return byId;
  const byQualified = preferBody(all.filter((node) => node.qualifiedName === selector));
  if (byQualified !== undefined) return byQualified;
  const byName = preferBody(all.filter((node) => node.name === selector));
  if (byName !== undefined) return byName;
  return all.find((node) => node.qualifiedName.toLowerCase() === selector.toLowerCase());
}

function preferBody(candidates: SymbolNode[]): SymbolNode | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.find((node) => node.body !== undefined) ?? candidates[0];
}

/** True when the symbol is callable (has a body worth expanding/dep-scanning). */
export function isFunctionLike(node: SymbolNode): boolean {
  return (
    node.kind === "function" ||
    node.kind === "method" ||
    node.kind === "constructor" ||
    node.kind === "getter" ||
    node.kind === "setter"
  );
}

export { FUNCTION_KINDS };
