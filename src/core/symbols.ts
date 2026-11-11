/**
 * Turns documentSymbol output into the symbol model the rest of the query
 * layer uses: qualified names, checker-resolved signatures, folded bodies.
 *
 * This is deliberately the *only* place that builds symbol identity. skeleton,
 * deps, expand, usages and search all consume the same nodes.
 *
 * Nothing here knows a language: classification, name offsets, bodies,
 * signatures and globals all come from the {@link LanguageProfile} of the
 * session's server.
 */
import type { LspSession, SessionSymbol } from "../lsp/session.ts";
import { profileForServer, type LanguageProfile } from "../languages/profile.ts";
import type { DeclarationKind, SymbolFacts } from "../languages/types.ts";
import type { SourceText } from "./source-text.ts";
import { formatFunctionId } from "./ids.ts";

export interface SymbolNode {
  /** Canonical id: relativePath#qualifiedName@hash6. */
  id: string;
  /** Workspace-relative path with POSIX separators. */
  path: string;
  name: string;
  qualifiedName: string;
  kind: DeclarationKind;
  /** Checker-resolved signature (fallback: the source header). */
  signature: string;
  /**
   * Where the signature came from. 'checker' is the normal case; 'source'
   * means the server could not describe it faithfully (overload
   * implementations, setters, constructors, impl blocks) and the written
   * header was used.
   */
  signatureSource: "checker" | "source";
  /** Byte range of the whole declaration. */
  range: { start: number; end: number };
  /** Byte range of the declaration's name (the identifier). */
  selectionRange: { start: number; end: number };
  /**
   * Byte offset of the name the server will recognise.
   *
   * documentSymbol reports the whole declaration as selectionRange for
   * overload implementations, and LSP would then resolve no symbol there;
   * this offset always points at the identifier itself.
   */
  nameOffset: number;
  /** Byte range of the body, when the declaration has one. */
  body?: { start: number; end: number; lines: number; expression: boolean };
  children: SymbolNode[];
  exported: boolean;
  /** Heritage clause, already rendered ('extends A implements B', ': Send'). */
  heritage?: string;
  /** First parameter name (setters need it to render 'set x(value: T)'). */
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
  /** Top-level regions that are not part of any symbol (imports, use, globals). */
  globals: Array<{ range: { start: number; end: number }; lines: number }>;
  /** The profile that produced this tree. */
  profile: LanguageProfile;
}

/** Build the symbol tree for one file. */
export async function buildSymbolTree(
  session: LspSession,
  filePath: string,
  profile: LanguageProfile = profileForServer(session.serverName),
): Promise<DocumentSkeleton> {
  const relativePath = session.relativePath(session.resolvePath(filePath));
  const document = await session.openDocument(filePath);
  const source = document.source;
  const raw = await session.documentSymbols(filePath);
  const symbols: SymbolNode[] = [];
  for (const symbol of inDocumentOrder(raw)) {
    const node = await convertSymbol(session, profile, relativePath, source, symbol, undefined);
    if (node !== undefined) symbols.push(node);
  }
  const globals = collectGlobals(profile, relativePath, source, symbols);
  return { path: relativePath, source, symbols, globals, profile };
}

async function convertSymbol(
  session: LspSession,
  profile: LanguageProfile,
  path: string,
  source: SourceText,
  symbol: SessionSymbol,
  parent: SymbolNode | undefined,
): Promise<SymbolNode | undefined> {
  const kind = profile.classify({
    filePath: path,
    source,
    symbol,
    ...(parent === undefined ? {} : { parentKind: parent.kind }),
  });
  // The profile decides what is a declaration of this module. A local binding
  // inside a function body is not one, so it never reaches the skeleton.
  if (kind === undefined) return undefined;

  const facts: SymbolFacts = {
    filePath: path,
    source,
    symbol,
    ...(parent === undefined ? {} : { parentKind: parent.kind }),
    kind,
    nameOffset: 0,
    range: symbol.range,
  };
  facts.nameOffset = profile.nameOffset(facts);
  facts.range = { start: profile.declarationStart(facts), end: symbol.range.end };

  // Only the profile knows whether the server's hover carries anything its
  // describe() cannot get otherwise; skipping it saves one round trip per
  // symbol for a language whose signature lives in documentSymbol.detail.
  const hover = profile.wantsHover ? await session.hover(path, facts.nameOffset) : undefined;
  const described = profile.describe(facts, hover?.markdown);
  const qualifiedName = profile.qualify(facts, parent?.qualifiedName);
  const children: SymbolNode[] = [];
  const node: SymbolNode = {
    id: formatFunctionId(path, qualifiedName, described.signature.signature, kind),
    path,
    name: symbol.name,
    qualifiedName,
    kind,
    signature: described.signature.signature,
    signatureSource: described.signature.source,
    range: facts.range,
    selectionRange: symbol.selectionRange,
    nameOffset: facts.nameOffset,
    children,
    exported: profile.exported(facts),
    lspKind: symbol.kind,
  };
  if (described.doc !== undefined) node.doc = described.doc;
  const heritage = profile.heritage(facts);
  if (heritage !== undefined) node.heritage = heritage;
  const body = profile.body(facts);
  if (body !== undefined) node.body = body;
  const parameterName = profile.parameterName(facts);
  if (parameterName !== undefined) node.parameterName = parameterName;

  for (const child of inDocumentOrder(symbol.children)) {
    const converted = await convertSymbol(session, profile, path, source, child, node);
    if (converted !== undefined) children.push(converted);
  }
  return node;
}

/**
 * Copy a sibling list into source order.
 *
 * documentSymbol is *not* ordered by position: the TypeScript servers build
 * the answer from TypeScript's navigation tree, which sorts children
 * alphabetically (`compareChildren` in typescript.js). Rendering that list as
 * received made declarations appear in name order, while globals stayed in
 * source order -- which is why imports looked right and the declarations looked
 * reversed.
 *
 * This sorts the *raw* ranges, before SymbolNode widens them: declarationStart
 * stretches a member's range to its enclosing top-level statement, so sorting
 * converted nodes would tie every member of a class on the same offset.
 */
function inDocumentOrder(symbols: SessionSymbol[]): SessionSymbol[] {
  return [...symbols].sort((left, right) => left.range.start - right.range.start);
}

/**
 * Top-level regions that no symbol covers: imports and global statements.
 *
 * Working per *statement* (rather than per character gap) keeps partial
 * declarations such as `const store = ...` from being split in two. The
 * profile owns what a statement is, because only it knows the grammar.
 */
function collectGlobals(
  profile: LanguageProfile,
  path: string,
  source: SourceText,
  symbols: SymbolNode[],
): Array<{ range: { start: number; end: number }; lines: number }> {
  const covered = flatten(symbols).map((symbol) => symbol.range);
  return profile.globals({ filePath: path, source, covered });
}

/** A symbol resolved from an offset, with the facts needed to re-describe it. */
export interface ResolvedSymbol {
  node: SymbolNode;
  /** The file's text (the profile needs it to read the written header). */
  source: SourceText;
  /** The raw documentSymbol entry of the innermost declaration. */
  raw: SessionSymbol;
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
  profile: LanguageProfile = profileForServer(session.serverName),
): Promise<ResolvedSymbol | undefined> {
  const relativePath = session.relativePath(session.resolvePath(filePath));
  const document = await session.openDocument(filePath);
  const raw = await session.documentSymbols(filePath);
  const chain = findSymbolChain(raw, offset);
  const innermost = chain[chain.length - 1];
  if (innermost === undefined) return undefined;
  let parent: SymbolNode | undefined;
  for (const symbol of chain) {
    parent = await convertSymbol(session, profile, relativePath, document.source, symbol, parent);
    if (parent === undefined) return undefined;
  }
  return parent === undefined ? undefined : { node: parent, source: document.source, raw: innermost };
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
 * deps('parse') scans the implementation instead of an empty signature.
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
