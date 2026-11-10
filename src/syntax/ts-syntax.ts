/**
 * Syntax helpers built on the TypeScript parser.
 *
 * These helpers locate names, fold bodies, classify declarations and enumerate
 * *candidate* call sites inside a range. They never decide what a name refers
 * to: every candidate is handed to the language server, which owns resolution.
 *
 * Positions: callers speak **byte offsets** (the query layer's unit), while the
 * TypeScript parser speaks **UTF-16 offsets**. {@link SourceText} owns that
 * conversion, and it happens here so that no caller has to know about it.
 */
import ts from "typescript";

import { SourceText } from "../core/source-text.ts";

export type DeclarationKind =
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "enum-member"
  | "property"
  | "variable"
  | "namespace"
  | "unknown";

/** A call-site candidate: the callee expression and the enclosing call. */
export interface CallSiteCandidate {
  /** Byte offset of the callee expression. */
  calleeStart: number;
  /** Byte offset just past the callee expression. */
  calleeEnd: number;
  /** Byte offset of the whole call expression. */
  callStart: number;
  callEnd: number;
  /** Source text of the callee, e.g. `this.notifier.notify`. */
  calleeText: string;
  /** True for `new X(...)`. */
  isNew: boolean;
  /** 1-based line of the callee. */
  line: number;
}

/** The foldable body of a function-like declaration. */
export interface BodySpan {
  /** Byte offset where the body starts (opening brace or arrow expression). */
  start: number;
  /** Byte offset just past the body. */
  end: number;
  /** Number of source lines the body occupies. */
  lines: number;
  /** True when the declaration has an expression body instead of a block. */
  expression: boolean;
}

/** One top-level statement of a source file. */
export interface TopLevelStatement {
  start: number;
  end: number;
  isImport: boolean;
  isDeclaration: boolean;
}

function scriptKindOf(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  if (filePath.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

const parseCache = new Map<string, { text: string; source: ts.SourceFile }>();

/** Parse a file (cached by exact content) into a TypeScript syntax tree. */
export function parseTypeScript(filePath: string, source: SourceText): ts.SourceFile {
  const cached = parseCache.get(filePath);
  if (cached !== undefined && cached.text === source.text) return cached.source;
  const parsed = ts.createSourceFile(filePath, source.text, ts.ScriptTarget.Latest, true, scriptKindOf(filePath));
  parseCache.set(filePath, { text: source.text, source: parsed });
  return parsed;
}

/** Innermost syntax node containing a UTF-16 offset. */
function nodeAtUtf16(parsed: ts.SourceFile, offset: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getFullStart() || offset >= node.getEnd()) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

type FunctionLikeWithBody =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

function closestNamedNode(node: ts.Node): ts.Declaration | undefined {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    // Constructors have no name node but are declarations in their own right.
    if (ts.isConstructorDeclaration(current)) return current;
    // `getNameOfDeclaration` returns the identifier itself for a plain
    // identifier, so only accept nodes whose name is a *different* node.
    const name = ts.getNameOfDeclaration(current as ts.Declaration);
    if (name !== undefined && name !== current) return current as ts.Declaration;
    current = current.parent;
  }
  return undefined;
}

function functionLikeOf(node: ts.Declaration | undefined): FunctionLikeWithBody | undefined {
  if (node === undefined) return undefined;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ) {
    return node;
  }
  if (ts.isVariableDeclaration(node)) {
    const initializer = node.initializer;
    if (initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return initializer;
    }
  }
  return undefined;
}

/** Declaration that owns the first token of a byte range in the file. */
function declarationAt(
  filePath: string,
  source: SourceText,
  range: { start: number; end: number },
): ts.Declaration | undefined {
  const parsed = parseTypeScript(filePath, source);
  const node = nodeAtUtf16(parsed, source.toUtf16(range.start));
  return node === undefined ? undefined : closestNamedNode(node);
}

/** Offset of a declaration's name, as a byte offset. */
export function declarationNameOffset(
  filePath: string,
  source: SourceText,
  range: { start: number; end: number },
  name: string,
): number {
  const parsed = parseTypeScript(filePath, source);
  const declaration = declarationAt(filePath, source, range);
  const nameNode = declaration === undefined ? undefined : ts.getNameOfDeclaration(declaration);
  if (nameNode !== undefined && nameNode.getText(parsed) === name) return source.toByte(nameNode.getStart(parsed));
  // Constructors and anonymous members have no name node; fall back to the
  // first whole-word occurrence inside the declaration.
  const slice = source.slice(range.start, range.end);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).exec(slice);
  return match === null ? range.start : range.start + Buffer.byteLength(slice.slice(0, match.index), "utf8");
}

/** Classify a declaration from its syntax. */
export function classifyDeclaration(
  filePath: string,
  source: SourceText,
  range: { start: number; end: number },
): DeclarationKind {
  const declaration = declarationAt(filePath, source, range);
  if (declaration === undefined) return "unknown";
  if (ts.isFunctionDeclaration(declaration)) return "function";
  if (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) return "method";
  if (ts.isConstructorDeclaration(declaration)) return "constructor";
  if (ts.isGetAccessorDeclaration(declaration)) return "getter";
  if (ts.isSetAccessorDeclaration(declaration)) return "setter";
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return "class";
  if (ts.isInterfaceDeclaration(declaration)) return "interface";
  if (ts.isTypeAliasDeclaration(declaration)) return "type-alias";
  if (ts.isEnumDeclaration(declaration)) return "enum";
  if (ts.isEnumMember(declaration)) return "enum-member";
  if (ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration)) return "property";
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = declaration.initializer;
    if (initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return "function";
    }
    return "variable";
  }
  if (ts.isModuleDeclaration(declaration)) return "namespace";
  return "unknown";
}

/** The body of a function-like declaration, or `undefined` for others. */
export function bodyOf(
  filePath: string,
  source: SourceText,
  range: { start: number; end: number },
): BodySpan | undefined {
  const parsed = parseTypeScript(filePath, source);
  const functionLike = functionLikeOf(declarationAt(filePath, source, range));
  const body = functionLike?.body;
  if (body === undefined) return undefined;
  const start = source.toByte(body.getStart(parsed));
  const end = source.toByte(body.getEnd());
  return {
    start,
    end,
    lines: source.linesIn(start, end),
    expression: !ts.isBlock(body),
  };
}

/**
 * Declaration header exactly as written (modifiers, `get`/`set`, parameters),
 * from the first token to the opening brace or expression body. Comments and
 * leading trivia are excluded.
 */
export function signatureHeader(
  filePath: string,
  source: SourceText,
  range: { start: number; end: number },
): string | undefined {
  const parsed = parseTypeScript(filePath, source);
  const functionLike = functionLikeOf(declarationAt(filePath, source, range));
  if (functionLike === undefined) return undefined;
  const start = functionLike.getStart(parsed);
  const end = functionLike.body === undefined ? functionLike.getEnd() : functionLike.body.getStart(parsed);
  return source.text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Start of a declaration including its modifiers (`export`, `declare`, ...).
 *
 * `documentSymbol` reports a variable declaration's range starting at its
 * name, so slicing that range loses `export const`. Widening to the enclosing
 * top-level statement keeps `expand` faithful to the source.
 */
export function declarationStart(filePath: string, source: SourceText, range: { start: number; end: number }): number {
  const parsed = parseTypeScript(filePath, source);
  const declaration = declarationAt(filePath, source, range);
  if (declaration === undefined) return range.start;
  let outermost: ts.Node = declaration;
  while (outermost.parent !== undefined && !ts.isSourceFile(outermost.parent)) {
    outermost = outermost.parent;
  }
  if (!ts.isSourceFile(outermost.parent)) return range.start;
  return source.toByte(outermost.getStart(parsed));
}

/** Parameter names of a function-like declaration, in source order. */
export function parameterNames(
  filePath: string,
  source: SourceText,
  range: { start: number; end: number },
): string[] {
  const parsed = parseTypeScript(filePath, source);
  const declaration = declarationAt(filePath, source, range);
  const functionLike = functionLikeOf(declaration);
  if (functionLike === undefined) return [];
  return functionLike.parameters.map((parameter) => parameter.name.getText(parsed));
}

/** Heritage clause (`extends X implements Y`) of a class/interface. */
export function heritageText(
  filePath: string,
  source: SourceText,
  range: { start: number; end: number },
): string | undefined {
  const parsed = parseTypeScript(filePath, source);
  const declaration = declarationAt(filePath, source, range);
  if (declaration === undefined) return undefined;
  if (
    !ts.isClassDeclaration(declaration) &&
    !ts.isClassExpression(declaration) &&
    !ts.isInterfaceDeclaration(declaration)
  ) {
    return undefined;
  }
  const clauses: string[] = [];
  for (const clause of declaration.heritageClauses ?? []) {
    const types = clause.types.map((type) => type.getText(parsed)).join(", ");
    clauses.push(`${clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements"} ${types}`);
  }
  return clauses.length === 0 ? undefined : clauses.join(" ");
}

/** Whether the declaration begins with an `export` modifier. */
export function isExported(filePath: string, source: SourceText, range: { start: number; end: number }): boolean {
  const declaration = declarationAt(filePath, source, range);
  if (declaration === undefined) return false;
  const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Enumerate the top-level statements of a file, in source order. */
export function topLevelStatements(filePath: string, source: SourceText): TopLevelStatement[] {
  const parsed = parseTypeScript(filePath, source);
  return parsed.statements.map((statement) => ({
    start: source.toByte(statement.getStart(parsed)),
    end: source.toByte(statement.getEnd()),
    isImport: ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement),
    isDeclaration:
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement),
  }));
}

/**
 * Direct call-site candidates of one function body, excluding nested closures.
 *
 * A call inside a callback belongs to the callback, not to the enclosing
 * function; TypeScript's own call hierarchy does not make that distinction for
 * anonymous arrows, so attribution is done here.
 */
export function directCallSites(filePath: string, source: SourceText, body: { start: number; end: number }): CallSiteCandidate[] {
  const parsed = parseTypeScript(filePath, source);
  const bodyStart = source.toUtf16(body.start);
  const bodyEnd = source.toUtf16(body.end);
  const bodyNode = nodeAtUtf16(parsed, bodyStart);
  const result: CallSiteCandidate[] = [];

  const record = (node: ts.CallExpression | ts.NewExpression): void => {
    const callee = node.expression;
    const calleeStart = callee.getStart(parsed);
    if (calleeStart < bodyStart || calleeStart >= bodyEnd) return;
    const calleeByteStart = source.toByte(calleeStart);
    const calleeByteEnd = source.toByte(callee.getEnd());
    result.push({
      calleeStart: calleeByteStart,
      calleeEnd: calleeByteEnd,
      callStart: source.toByte(node.getStart(parsed)),
      callEnd: source.toByte(node.getEnd()),
      calleeText: source.text.slice(calleeStart, callee.getEnd()),
      isNew: ts.isNewExpression(node),
      line: source.lineAt(calleeByteStart),
    });
  };

  const visit = (node: ts.Node, depth: number): void => {
    if (node.getEnd() <= bodyStart || node.getStart(parsed) >= bodyEnd) return;
    if (depth > 0 && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) record(node);
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };

  // Start *inside* the body node; otherwise the enclosing function itself
  // would terminate the traversal at depth 1.
  if (bodyNode === undefined) {
    for (const statement of parsed.statements) visit(statement, 0);
  } else {
    ts.forEachChild(bodyNode, (child) => visit(child, 1));
  }

  const deduped = new Map<string, CallSiteCandidate>();
  for (const site of result) deduped.set(`${site.calleeStart}:${site.calleeEnd}`, site);
  return [...deduped.values()].sort((left, right) => left.calleeStart - right.calleeStart);
}
