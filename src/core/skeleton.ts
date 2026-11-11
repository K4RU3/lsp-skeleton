/**
 * Renders the skeleton: structure and types only, bodies folded.
 *
 * Everything here operates on the shared {@link SymbolNode} tree built from
 * documentSymbol plus the language profile, so skeleton, deps and expand agree
 * on identity. The renderer knows three shapes ({@link RenderLayout}) and never
 * checks which language produced a node: the profile chooses the shape, the
 * export prefix and the layout of a global region.
 */
import type { SymbolNode } from "./symbols.ts";
import type { LanguageProfile } from "../languages/profile.ts";
import type { SourceText } from "./source-text.ts";

export interface SkeletonOptions {
  /** Include the leading '// path' line. */
  header?: boolean;
  /** Include doc summaries above declarations. */
  docs?: boolean;
  /** Include top-level statements that are not declarations (imports, ...). */
  globals?: boolean;
  /** Include the trailing '// exports:' summary. */
  exports?: boolean;
  /** Include member declarations of classes/interfaces/structs. */
  members?: boolean;
}

const DEFAULTS: Required<SkeletonOptions> = {
  header: true,
  docs: true,
  globals: true,
  exports: true,
  members: true,
};

export interface SkeletonInput {
  path: string;
  /** The file's text, with the byte <-> UTF-16 conversion the slices need. */
  source: SourceText;
  symbols: SymbolNode[];
  globals: Array<{ range: { start: number; end: number }; lines: number }>;
  exports: string[];
  /** The profile that produced the tree; drives layout and global rendering. */
  profile: LanguageProfile;
  options?: SkeletonOptions;
}

export interface SkeletonResult {
  path: string;
  text: string;
  /** Number of rendered declarations (including members). */
  symbolCount: number;
  /** Names exported from the file, when the caller asked for the summary. */
  exports: string[];
}

/** Render one file's skeleton. */
export function renderSkeleton(input: SkeletonInput): SkeletonResult {
  const options: Required<SkeletonOptions> = { ...DEFAULTS, ...input.options };
  const lines: string[] = [];
  let symbolCount = 0;
  if (options.header) {
    const exported = input.exports.length === 0 ? "" : ` · export ${input.exports.length}`;
    lines.push(`// ${input.path}${exported}`);
  }
  if (options.globals) {
    for (const span of input.globals) {
      // Byte offsets, so slice through SourceText: JS string indices are UTF-16
      // and slicing a file containing multi-byte text with byte offsets silently
      // drops the leading characters (the Rust before-fixture's " d / r = ").
      const code = input.source.slice(span.range.start, span.range.end);
      const rendered = input.profile.renderGlobal?.(input.path, code);
      const spanLines = rendered ?? code.split("\n").map((line) => line.replace(/\s+$/, ""));
      lines.push(...spanLines);
    }
    if (input.globals.length > 0 && input.symbols.length > 0) lines.push("");
  }
  for (const symbol of input.symbols) {
    const rendered = renderDeclaration(input.source, input.profile, symbol, 0, options);
    symbolCount += rendered.count;
    lines.push(...rendered.lines);
  }
  if (options.exports && input.exports.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(`// exports: ${input.exports.join(", ")}`);
  }
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return { path: input.path, text, symbolCount, exports: input.exports };
}

function renderDeclaration(
  source: SourceText,
  profile: LanguageProfile,
  node: SymbolNode,
  depth: number,
  options: Required<SkeletonOptions>,
): { lines: string[]; count: number } {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let count = 0;
  if (options.docs && node.doc !== undefined && isCallable(node)) lines.push(`${indent}${docLine(node.doc)}`);

  switch (profile.layout(node.kind, node)) {
    case "whole": {
      // Type definitions are the payload of a skeleton: keep them whole.
      const text = declarationText(source, node);
      for (const line of text.split("\n")) lines.push(line.trim() === "" ? "" : `${indent}${line}`);
      return { lines, count: count + 1 };
    }
    case "block": {
      const prefix = node.exported && depth === 0 ? profile.exportPrefix : "";
      const heritage = node.heritage === undefined ? "" : ` ${node.heritage}`;
      lines.push(`${indent}${prefix}${stripExport(node.signature)}${heritage} {`);
      count += 1;
      if (options.members) {
        for (const child of node.children) {
          const rendered = renderDeclaration(source, profile, child, depth + 1, options);
          count += rendered.count;
          lines.push(...rendered.lines);
        }
      }
      lines.push(`${indent}}`);
      return { lines, count };
    }
    case "line": {
      const prefix = node.exported && depth === 0 ? profile.exportPrefix : "";
      lines.push(`${indent}${prefix}${displaySignature(node)}${foldComment(node)}`);
      return { lines, count: count + 1 };
    }
  }
}

function isCallable(node: SymbolNode): boolean {
  return (
    node.kind === "function" ||
    node.kind === "method" ||
    node.kind === "constructor" ||
    node.kind === "getter" ||
    node.kind === "setter"
  );
}

function docLine(doc: string): string {
  const oneLine = doc.replace(/\s*\n\s*/g, " ").trim();
  if (oneLine.length <= 110) return `/** ${oneLine} */`;
  return `/** ${oneLine.slice(0, 107)}… */`;
}

function foldComment(node: SymbolNode): string {
  if (node.body === undefined) return "";
  const lines = node.body.lines;
  return `  // … ${lines} ${lines === 1 ? "line" : "lines"}`;
}

function stripExport(signature: string): string {
  return normalize(signature).replace(/^export\s+/, "");
}

/**
 * Signature with the receiver the enclosing declaration already names removed.
 *
 * 'SessionStore.refresh(token: string)' -> 'refresh(token: string)'. The
 * accessor keyword is kept: 'get size()' is 'get' + 'size('.
 */
function displaySignature(node: SymbolNode): string {
  const signature = stripExport(node.signature);
  const dot = node.qualifiedName.lastIndexOf(".");
  if (dot < 0) return signature;
  const receiver = node.qualifiedName.slice(0, dot);
  const prefix = `${receiver}.`;
  if (!signature.startsWith(prefix)) return signature;
  return signature.slice(prefix.length);
}

/** Declaration text (no body), preserving the source's own line structure. */
function declarationText(source: SourceText, node: SymbolNode): string {
  const raw = source.slice(node.range.start, node.body?.start ?? node.range.end);
  const lines = raw.split("\n");
  const first = lines[0];
  if (first !== undefined) lines[0] = first.trimStart();
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines.join("\n");
}

function normalize(signature: string): string {
  return signature.replace(/\s+/g, " ").trim();
}