/**
 * Turns `documentSymbol` output into the symbol model the rest of the query
 * layer uses: qualified names, checker-resolved signatures, folded bodies.
 *
 * This is deliberately the *only* place that builds symbol identity. skeleton,
 * deps, expand, usages and search all consume the same nodes.
 */
import { SymbolKind as LspSymbolKind } from "../lsp/protocol.ts";
import type { LspSession, SessionSymbol } from "../lsp/session.ts";
import {
  bodyOf,
  classifyDeclaration,
  declarationNameOffset,
  declarationStart,
  heritageText,
  isExported,
  parameterNames,
  signatureHeader,
  topLevelStatements,
  type DeclarationKind,
} from "../syntax/ts-syntax.ts";
import { parseHover, stripReceiver } from "./hover-text.ts";
import { formatFunctionId } from "./ids.ts";
import type { SourceText } from "./source-text.ts";

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
   * implementations, setters, constructors) and the written header was used.
   */
  signatureSource: "checker" | "source";
  /** Byte range of the whole declaration. */
  range: { start: number; end: number };
  /** Byte range of the declaration's name (the identifier). */
  selectionRange: { start: number; end: number };
  /**
   * Byte offset of the name the server will recognise.
   *
   * `documentSymbol` reports the whole declaration as `selectionRange` for
   * overload implementations, and LSP would then resolve no symbol there;
   * this offset always points at the identifier itself.
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
  /** Symbol kind as reported by the server (kept for filters). */
  lspKind: number;
  doc?: string;
}

export interface DocumentSkeleton {
  /** Workspace-relative path. */
  path: string;
  source: SourceText;
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
  const relativePath = session.relativePath(session.resolvePath(filePath));
  const document = await session.openDocument(filePath);
  const source = document.source;
  const raw = await session.documentSymbols(filePath);
  const symbols = await Promise.all(
    raw.map((symbol) => convertSymbol(session, relativePath, source, symbol, undefined)),
  );
  const globals = collectGlobals(relativePath, source, symbols);
  return { path: relativePath, source, symbols, globals };
}

async function convertSymbol(
  session: LspSession,
  path: string,
  source: SourceText,
  symbol: SessionSymbol,
  parent: SymbolNode | undefined,
): Promise<SymbolNode> {
  const nameOffset = declarationNameOffset(path, source, symbol.range, symbol.name);
  const kind = classifyDeclaration(path, source, symbol.range);
  const qualifiedName = parent === undefined ? symbol.name : `${parent.qualifiedName}.${symbol.name}`;
  const isClassOrInterface = kind === "class" || kind === "interface";

  const resolved = await resolveSignature(session, path, source, symbol, nameOffset, kind);
  const range = { start: declarationStart(path, source, symbol.range), end: symbol.range.end };
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
    exported: isExported(path, source, symbol.range),
    lspKind: symbol.kind,
  };
  const hover = await session.hover(path, nameOffset);
  const parsed = hover === undefined ? undefined : parseHover(hover.markdown);
  if (parsed?.doc !== undefined) node.doc = parsed.doc;
  if (isClassOrInterface) {
    const heritage = heritageText(path, source, symbol.range);
    if (heritage !== undefined) node.heritage = heritage;
  }
  const body = bodyOf(path, source, symbol.range);
  if (body !== undefined) node.body = body;
  if (kind === "setter") {
    const first = parameterNames(path, source, symbol.range)[0];
    if (first !== undefined) node.parameterName = first;
  }
  for (const child of symbol.children) {
    children.push(await convertSymbol(session, path, source, child, node));
  }
  return node;
}

async function resolveSignature(
  session: LspSession,
  path: string,
  source: SourceText,
  symbol: SessionSymbol,
  nameOffset: number,
  kind: DeclarationKind,
): Promise<{ signature: string; source: "checker" | "source" }> {
  const hover = await session.hover(path, nameOffset);
  const parsed = hover === undefined ? undefined : parseHover(hover.markdown);
  const header = normalizeHeader(signatureHeader(path, source, symbol.range));
  if (kind === "setter" || kind === "getter" || kind === "constructor") {
    // Hover renders accessors by their property type (a setter loses its
    // parameter) and constructors with a redundant return type, so the
    // written header is the faithful signature for these three kinds.
    if (header !== undefined) return { signature: header, source: "source" };
  }
  if (parsed !== undefined && parsed.overloads > 0 && header !== undefined && hasBody(path, source, symbol.range)) {
    // For an overload *implementation*, hover repeats the first overload
    // (`(+N overloads)`) instead of the implementation's own signature, so
    // the annotated header is the only faithful description of it.
    if (header.includes("):") || header.includes("): ")) return { signature: header, source: "source" };
  }
  if (parsed !== undefined) {
    if (kind === "type-alias" || kind === "enum") return { signature: parsed.signature, source: "checker" };
    if (parsed.signature !== "") return { signature: stripReceiver(parsed.signature, symbol.name), source: "checker" };
  }
  const fallback = header ?? normalizeHeader(fallbackHeader(source, symbol, nameOffset));
  return { signature: fallback === undefined || fallback === "" ? symbol.name : fallback, source: "source" };
}

/** Collapse whitespace and drop modifiers the skeleton re-adds itself. */
function normalizeHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const normalized = header.replace(/\s+/g, " ").replace(/^export\s+/, "").replace(/^declare\s+/, "").trim();
  return normalized === "" ? undefined : normalized;
}

function fallbackHeader(source: SourceText, symbol: SessionSymbol, nameOffset: number): string {
  const before = source.slice(symbol.range.start, nameOffset);
  const afterName = source.slice(nameOffset, symbol.range.end);
  const headerEnd = afterName.search(/[{(=]/);
  return (before + (headerEnd < 0 ? afterName : afterName.slice(0, headerEnd))).trim();
}

function hasBody(path: string, source: SourceText, range: { start: number; end: number }): boolean {
  return bodyOf(path, source, range) !== undefined;
}

/**
 * Top-level statements that no symbol covers: imports and global statements.
 *
 * Working per *statement* (rather than per character gap) keeps partial
 * declarations such as `const store = ...` from being split in two.
 */
function collectGlobals(
  path: string,
  source: SourceText,
  symbols: SymbolNode[],
): Array<{ range: { start: number; end: number }; lines: number }> {
  const covered = flatten(symbols).map((symbol) => symbol.range);
  const globals: Array<{ range: { start: number; end: number }; lines: number }> = [];
  for (const statement of topLevelStatements(path, source)) {
    const overlaps = covered.some((range) => range.start < statement.end && statement.start < range.end);
    if (overlaps) continue;
    globals.push({
      range: { start: statement.start, end: statement.end },
      lines: source.linesIn(statement.start, statement.end),
    });
  }
  return globals;
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
  const raw = await session.documentSymbols(filePath);
  const chain = findSymbolChain(raw, offset);
  if (chain.length === 0) return undefined;
  let parent: SymbolNode | undefined;
  for (const symbol of chain) {
    parent = await convertSymbol(session, relativePath, document.source, symbol, parent);
  }
  return parent;
}

/** Symbols from the outermost to the innermost containing `offset`. */
function findSymbolChain(symbols: SessionSymbol[], offset: number): SessionSymbol[] {
  for (const symbol of symbols) {
    if (offset < symbol.range.start || offset > symbol.range.end) continue;
    return [symbol, ...findSymbolChain(symbol.children, offset)];
  }
  return [];
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

/** True when the symbol is callable (has a body worth expanding/scanning). */
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
