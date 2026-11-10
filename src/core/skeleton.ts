/**
 * Renders the skeleton: structure and types only, bodies folded.
 *
 * Everything here operates on the shared {@link SymbolNode} tree built from
 * documentSymbol + hover, so skeleton, deps and expand agree on identity.
 */
import type { SymbolNode } from "./symbols.ts";

export interface SkeletonOptions {
  /** Include the leading `// path` line. */
  header?: boolean;
  /** Include JSDoc summaries above declarations. */
  docs?: boolean;
  /** Include top-level statements that are not declarations (imports, ...). */
  globals?: boolean;
  /** Include the trailing `// exports:` summary. */
  exports?: boolean;
  /** Include member declarations of classes/interfaces. */
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
  text: string;
  symbols: SymbolNode[];
  globals: Array<{ range: { start: number; end: number }; lines: number }>;
  exports: string[];
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
      const code = input.text.slice(span.range.start, span.range.end);
      for (const line of code.split("\n")) lines.push(line.replace(/\s+$/, ""));
    }
    if (input.globals.length > 0 && input.symbols.length > 0) lines.push("");
  }
  for (const symbol of input.symbols) {
    const rendered = renderDeclaration(input.text, symbol, 0, options);
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
  source: string,
  node: SymbolNode,
  depth: number,
  options: Required<SkeletonOptions>,
): { lines: string[]; count: number } {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let count = 0;
  if (options.docs && node.doc !== undefined && isCallable(node)) lines.push(`${indent}${docLine(node.doc)}`);

  switch (node.kind) {
    case "class": {
      const keyword = node.exported && depth === 0 ? "export class" : "class";
      const heritage = node.heritage === undefined ? "" : ` ${node.heritage}`;
      lines.push(`${indent}${keyword} ${node.name}${heritage} {`);
      count += 1;
      if (options.members) {
        for (const child of node.children) {
          const rendered = renderDeclaration(source, child, depth + 1, options);
          count += rendered.count;
          lines.push(...rendered.lines);
        }
      }
      lines.push(`${indent}}`);
      return { lines, count };
    }
    case "interface":
    case "enum":
    case "type-alias": {
      // Type definitions are the payload of a skeleton: keep them whole.
      const text = declarationText(source, node);
      for (const line of text.split("\n")) lines.push(line.trim() === "" ? "" : `${indent}${line}`);
      count += 1;
      return { lines, count };
    }
    case "function": {
      const prefix = node.exported && depth === 0 ? "export " : "";
      lines.push(`${indent}${prefix}${stripExport(node.signature)}${foldComment(node)}`);
      count += 1;
      return { lines, count };
    }
    case "method":
    case "getter":
    case "setter":
    case "constructor": {
      lines.push(`${indent}${stripReceiverFromSignature(node)}${foldComment(node)}`);
      count += 1;
      return { lines, count };
    }
    default: {
      const prefix = node.exported && depth === 0 ? "export " : "";
      lines.push(`${indent}${prefix}${memberSignature(node)}${foldComment(node)}`);
      count += 1;
      return { lines, count };
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

/** `SessionStore.refresh(token: string)` -> `refresh(token: string)` */
function stripReceiverFromSignature(node: SymbolNode): string {
  const signature = stripExport(node.signature);
  const marker = `${node.name}(`;
  const index = signature.indexOf(marker);
  if (index <= 0) return signature;
  const prefix = signature.slice(0, index);
  // Keep the accessor keyword: `get size()` is `get` + `size(`.
  const keyword = /(?:get|set)\s+$/.exec(prefix);
  const head = keyword === null ? "" : keyword[0].trim() + " ";
  return head + signature.slice(index);
}

function memberSignature(node: SymbolNode): string {
  const signature = stripExport(node.signature);
  const dot = node.qualifiedName.lastIndexOf(".");
  if (dot < 0) return signature;
  const receiver = node.qualifiedName.slice(0, dot);
  const prefix = `${receiver}.`;
  return signature.startsWith(prefix) ? signature.slice(prefix.length) : signature;
}

/** Declaration text (no body), preserving the source's own line structure. */
function declarationText(source: string, node: SymbolNode): string {
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
