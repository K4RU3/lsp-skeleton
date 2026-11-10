/**
 * Syntax-only helpers built on the TypeScript scanner/parser.
 *
 * These helpers locate names, fold bodies and enumerate *candidate* call
 * sites inside a range. They never decide what a name refers to: every
 * candidate is handed to the language server, which owns resolution. Keeping
 * the syntactic fallback here (rather than an ad-hoc regex) avoids silently
 * missing call sites.
 */
import ts from "typescript";

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
  /** Byte offset of the callee expression (the identifier that is called). */
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
  /** Offset where the body starts (the opening brace or arrow expression). */
  start: number;
  /** Offset just past the body. */
  end: number;
  /** Number of source lines the body occupies. */
  lines: number;
  /** True when the declaration has no block body (e.g. arrow expression). */
  expression: boolean;
}

function scriptKindOf(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  if (filePath.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

const parseCache = new Map<string, { text: string; source: ts.SourceFile }>();

/** Parse text (cached by exact content) into a TypeScript syntax tree. */
export function parseTypeScript(filePath: string, text: string): ts.SourceFile {
  const cached = parseCache.get(filePath);
  if (cached !== undefined && cached.text === text) return cached.source;
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindOf(filePath));
  parseCache.set(filePath, { text, source });
  return source;
}

/** Offset of the smallest node whose span contains `offset`. */
export function nodeAtOffset(source: ts.SourceFile, offset: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getFullStart() || offset >= node.getEnd()) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** All call/new expressions whose callee lies inside [start, end). */
export function callSitesInRange(
  filePath: string,
  text: string,
  start: number,
  end: number,
): CallSiteCandidate[] {
  const source = parseTypeScript(filePath, text);
  const result: CallSiteCandidate[] = [];
  const visit = (node: ts.Node): void => {
    if (node.getEnd() <= start || node.getStart(source) >= end) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const calleeStart = callee.getStart(source);
      if (calleeStart >= start && calleeStart < end) {
        const isNew = ts.isNewExpression(node);
        result.push({
          calleeStart,
          calleeEnd: callee.getEnd(),
          callStart: node.getStart(source),
          callEnd: node.getEnd(),
          calleeText: callee.getText(source),
          isNew,
          line: source.getLineAndCharacterOfPosition(calleeStart).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  result.sort((left, right) => left.calleeStart - right.calleeStart);
  return result;
}

/** Offset of the identifier that names a declaration, given its full range. */
export function declarationNameOffset(
  filePath: string,
  text: string,
  range: { start: number; end: number },
  name: string,
): number {
  const source = parseTypeScript(filePath, text);
  const node = nodeAtOffset(source, range.start + Math.min(1, Math.max(0, range.end - range.start - 1)));
  if (node !== undefined) {
    const named = closestNamedNode(node);
    const declarationName = named === undefined ? undefined : ts.getNameOfDeclaration(named);
    if (declarationName !== undefined && declarationName.getText(source) === name) {
      return declarationName.getStart(source);
    }
  }
  // Fall back to the first whole-word occurrence inside the declaration.
  const slice = text.slice(range.start, range.end);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).exec(slice);
  return match === null ? range.start : range.start + match.index;
}

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

/** Classify a declaration from its syntax, with the document symbol as a hint. */
export function classifyDeclaration(
  filePath: string,
  text: string,
  range: { start: number; end: number },
  fallback: "function" | "other",
): DeclarationKind {
  const source = parseTypeScript(filePath, text);
  const node = nodeAtOffset(source, range.start);
  const named = node === undefined ? undefined : closestNamedNode(node);
  if (named === undefined) return fallback === "function" ? "function" : "unknown";
  if (ts.isFunctionDeclaration(named)) return "function";
  if (ts.isMethodDeclaration(named)) return "method";
  if (ts.isConstructorDeclaration(named)) return "constructor";
  if (ts.isGetAccessorDeclaration(named)) return "getter";
  if (ts.isSetAccessorDeclaration(named)) return "setter";
  if (ts.isClassDeclaration(named) || ts.isClassExpression(named)) return "class";
  if (ts.isInterfaceDeclaration(named)) return "interface";
  if (ts.isTypeAliasDeclaration(named)) return "type-alias";
  if (ts.isEnumDeclaration(named)) return "enum";
  if (ts.isEnumMember(named)) return "enum-member";
  if (ts.isPropertyDeclaration(named) || ts.isPropertySignature(named)) return "property";
  if (ts.isVariableDeclaration(named)) {
    const initializer = named.initializer;
    if (initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return "function";
    }
    return "variable";
  }
  if (ts.isModuleDeclaration(named)) return "namespace";
  return "unknown";
}

/** Innermost node whose span contains `offset`. */
function findNodeSpanning(source: ts.SourceFile, offset: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(source) || offset >= node.getEnd()) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The body of a function-like declaration, or `undefined` for non-functions. */
export function bodyOf(filePath: string, text: string, range: { start: number; end: number }): BodySpan | undefined {
  const source = parseTypeScript(filePath, text);
  const node = nodeAtOffset(source, range.start);
  const named = node === undefined ? undefined : closestNamedNode(node);
  const functionLike = functionLikeOf(named);
  if (functionLike === undefined) return undefined;
  if (functionLike.body === undefined) return undefined;
  const body = functionLike.body;
  if (ts.isBlock(body)) {
    const start = body.getStart(source);
    const end = body.getEnd();
    return { start, end, lines: countLines(text, start, end), expression: false };
  }
  const start = body.getStart(source);
  const end = body.getEnd();
  return { start, end, lines: countLines(text, start, end), expression: true };
}

type FunctionLikeWithBody = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function functionLikeOf(node: ts.Declaration | undefined): FunctionLikeWithBody | undefined {
  if (node === undefined) return undefined;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
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

/** Number of lines a byte range spans (empty ranges count as 0). */
export function countLines(text: string, start: number, end: number): number {
  if (end <= start) return 0;
  let lines = 1;
  for (let index = start; index < end && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/**
 * Declaration header exactly as written (modifiers, `get`/`set`, parameters),
 * from the first token to the opening brace/expression body. Comments and
 * leading trivia are excluded.
 */
export function signatureHeader(
  filePath: string,
  text: string,
  range: { start: number; end: number },
): string | undefined {
  const source = parseTypeScript(filePath, text);
  const node = nodeAtOffset(source, range.start);
  const named = node === undefined ? undefined : closestNamedNode(node);
  const functionLike = functionLikeOf(named);
  if (functionLike === undefined) return undefined;
  const start = functionLike.getStart(source);
  const end = functionLike.body === undefined ? functionLike.getEnd() : functionLike.body.getStart(source);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** One top-level statement of a source file. */
export interface TopLevelStatement {
  start: number;
  end: number;
  /** True for `import ...` / `export ... from` statements. */
  isImport: boolean;
  /** True for declarations that documentSymbol normally reports (fn/class/...). */
  isDeclaration: boolean;
}

/** Enumerate the top-level statements of a file, in source order. */
export function topLevelStatements(filePath: string, text: string): TopLevelStatement[] {
  const source = parseTypeScript(filePath, text);
  return source.statements.map((statement) => ({
    start: statement.getStart(source),
    end: statement.getEnd(),
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
 * Call-site candidates of one function body, excluding nested function bodies.
 *
 * A call inside a callback belongs to the callback, not to the enclosing
 * function; TypeScript's own call hierarchy does not make that distinction for
 * anonymous arrows, so attribution is done here.
 */
export function directCallSites(
  filePath: string,
  text: string,
  body: { start: number; end: number },
): CallSiteCandidate[] {
  const source = parseTypeScript(filePath, text);
  const result: CallSiteCandidate[] = [];
  const bodyNode = findNodeSpanning(source, body.start);
  const visit = (node: ts.Node, depth: number): void => {
    if (node.getEnd() <= body.start || node.getStart(source) >= body.end) return;
    if (depth > 0 && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const calleeStart = callee.getStart(source);
      if (calleeStart >= body.start && calleeStart < body.end) {
        result.push({
          calleeStart,
          calleeEnd: callee.getEnd(),
          callStart: node.getStart(source),
          callEnd: node.getEnd(),
          calleeText: callee.getText(source),
          isNew: ts.isNewExpression(node),
          line: source.getLineAndCharacterOfPosition(calleeStart).line + 1,
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  // Start *inside* the body node; otherwise the enclosing function itself
  // would terminate the traversal at depth 1.
  for (const child of bodyNode === undefined ? source.statements : [bodyNode]) {
    if (bodyNode === undefined) visit(child, 0);
    else ts.forEachChild(bodyNode, (inner) => visit(inner, 1));
  }
  const deduped = new Map<string, CallSiteCandidate>();
  for (const site of result) deduped.set(`${site.calleeStart}:${site.calleeEnd}`, site);
  return [...deduped.values()].sort((left, right) => left.calleeStart - right.calleeStart);
}

/** Parameter names of a setter/function declaration, in source order. */
export function parameterNames(filePath: string, text: string, range: { start: number; end: number }): string[] {
  const source = parseTypeScript(filePath, text);
  const node = nodeAtOffset(source, range.start);
  const named = node === undefined ? undefined : closestNamedNode(node);
  const value = named === undefined ? undefined : ts.getNameOfDeclaration(named);
  if (named === undefined || value === undefined) return [];
  if (!ts.isSetAccessorDeclaration(named)) return [];
  return named.parameters.map((parameter) => parameter.name.getText(source));
}

/** Heritage clause (`extends X implements Y`) of a class/interface header. */
export function heritageText(filePath: string, text: string, range: { start: number; end: number }): string | undefined {
  const source = parseTypeScript(filePath, text);
  const node = nodeAtOffset(source, range.start);
  const named = node === undefined ? undefined : closestNamedNode(node);
  if (named === undefined) return undefined;
  if (!ts.isClassDeclaration(named) && !ts.isClassExpression(named) && !ts.isInterfaceDeclaration(named)) return undefined;
  const clauses: string[] = [];
  if (named.heritageClauses !== undefined) {
    for (const clause of named.heritageClauses) {
      const types = clause.types.map((type) => type.getText(source)).join(", ");
      clauses.push(`${clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements"} ${types}`);
    }
  }
  return clauses.length === 0 ? undefined : clauses.join(" ");
}

/** Whether the declaration begins with an `export` modifier. */
export function isExported(filePath: string, text: string, range: { start: number; end: number }): boolean {
  const source = parseTypeScript(filePath, text);
  const node = nodeAtOffset(source, range.start);
  const named = node === undefined ? undefined : closestNamedNode(node);
  if (named === undefined) return false;
  const modifiers = ts.canHaveModifiers(named) ? ts.getModifiers(named) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Source text lines [from, to) trimmed, for global-code rendering. */
export function textLines(text: string, start: number, end: number): string[] {
  return text.slice(start, end).split("\n");
}
