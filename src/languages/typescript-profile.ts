/**
 * TypeScript / JavaScript profile.
 *
 * This is the original behaviour moved behind the profile seam, answer for
 * answer: the TypeScript parser supplies declaration ranges, hover supplies
 * checker-resolved signatures, locals stay in the symbol tree (the server nests
 * them and the renderer never draws them as declarations), and deps selects an
 * overload per call site with signatureHelp.
 */
import path from "node:path";

import { parseHover, stripReceiver } from "../core/hover-text.ts";
import type { ServerLaunchSpec } from "../lsp/session.ts";
import {
  bodyOf,
  classifyDeclaration,
  declarationNameOffset,
  declarationStart,
  directCallSites,
  heritageText,
  isExported,
  isImportPosition,
  parameterNames,
  signatureHeader,
  topLevelStatements,
} from "../syntax/ts-syntax.ts";
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

// A Map, not an object: the declaration kind "constructor" would otherwise
// collide with Object.prototype.constructor on lookup.
const LAYOUTS = new Map<string, RenderLayout>([
  ["class", "block"],
  ["interface", "whole"],
  ["enum", "whole"],
  ["type-alias", "whole"],
  ["namespace", "block"],
]);

export const typescriptProfile: LanguageProfile = {
  id: "typescript",
  servers: ["typescript-language-server", "vtsls"],
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
  keepsLocals: true,
  exportPrefix: "export ",
  // The inferred type of a const or arrow function exists only in hover, and
  // the JSDoc summary arrives in the same reply.
  wantsHover: true,

  languageId(filePath: string): string {
    switch (path.extname(filePath).toLowerCase()) {
      case ".tsx":
        return "typescriptreact";
      case ".jsx":
        return "javascriptreact";
      case ".js":
      case ".mjs":
      case ".cjs":
        return "javascript";
      case ".json":
        return "json";
      default:
        return "typescript";
    }
  },

  serverSpec(resolveBin: (packageName: string, binName: string) => string): ServerLaunchSpec {
    // The TypeScript server is a node script this package depends on.
    return {
      name: "typescript-language-server",
      command: process.execPath,
      args: [resolveBin("typescript-language-server", "typescript-language-server"), "--stdio"],
      initializationOptions: { hostInfo: "lsp-skeleton" },
    };
  },

  async projectEntry(): Promise<string | undefined> {
    // tsconfig/jsconfig discovery stays in the session, where it already lives.
    return undefined;
  },

  classify({ filePath, source, symbol }: ClassifyFacts): DeclarationKind | undefined {
    return classifyDeclaration(filePath, source, symbol.range);
  },

  qualify({ symbol }: SymbolFacts, parentQualifiedName: string | undefined): string {
    return parentQualifiedName === undefined ? symbol.name : `${parentQualifiedName}.${symbol.name}`;
  },

  nameOffset({ filePath, source, symbol }: SymbolFacts): number {
    return declarationNameOffset(filePath, source, symbol.range, symbol.name);
  },

  declarationStart({ filePath, source, symbol }: SymbolFacts): number {
    return declarationStart(filePath, source, symbol.range);
  },

  body({ filePath, source, symbol }: SymbolFacts): BodySpan | undefined {
    return bodyOf(filePath, source, symbol.range);
  },

  exported({ filePath, source, symbol }: SymbolFacts): boolean {
    return isExported(filePath, source, symbol.range);
  },

  emptyFileExplanation:
    "That can mean an empty file, a file outside the tsconfig project, or a server that has not finished loading.",

  isStdlibPath(filePath: string): boolean {
    // TypeScript's standard library is the lib.*.d.ts family.
    return /(?:^|\/)lib\.[^/]*\.d\.ts$/.test(filePath);
  },

  isExternalPath(filePath: string): boolean {
    return filePath.includes("node_modules/") || (filePath.endsWith(".d.ts") && !this.isStdlibPath(filePath));
  },

  stdlibNote(count: number): string {
    return `${count} call(s) to the standard library (lib.*.d.ts) were omitted as out of scope for deps.`;
  },

  heritage({ filePath, source, symbol }: SymbolFacts): string | undefined {
    return heritageText(filePath, source, symbol.range);
  },

  parameterName({ filePath, source, symbol }: SymbolFacts): string | undefined {
    return parameterNames(filePath, source, symbol.range)[0];
  },

  describe({ filePath, source, symbol, kind }: SymbolFacts, hover: string | undefined): ProfileDescription {
    const parsed = hover === undefined ? undefined : parseHover(hover);
    const header = normalizeHeader(signatureHeader(filePath, source, symbol.range));
    const overloads = parsed?.overloads ?? 0;
    const withDoc = (signature: string, from: "checker" | "source"): ProfileDescription => ({
      signature: { signature, source: from },
      ...(parsed?.doc === undefined ? {} : { doc: parsed.doc }),
      overloads,
    });
    if (kind === "setter" || kind === "getter" || kind === "constructor") {
      // Hover renders accessors by their property type (a setter loses its
      // parameter) and constructors with a redundant return type, so the
      // written header is the faithful signature for these three kinds.
      if (header !== undefined) return withDoc(header, "source");
    }
    if (parsed !== undefined && parsed.overloads > 0 && header !== undefined && bodyOf(filePath, source, symbol.range) !== undefined) {
      // For an overload implementation, hover repeats the first overload
      // ('(+N overloads)') instead of the implementation's own signature, so
      // the annotated header is the only faithful description of it.
      if (header.includes("):") || header.includes("): ")) return withDoc(header, "source");
    }
    if (parsed !== undefined) {
      if (kind === "type-alias" || kind === "enum") return withDoc(parsed.signature, "checker");
      if (parsed.signature !== "") return withDoc(stripReceiver(parsed.signature, symbol.name), "checker");
    }
    const fallback = header ?? normalizeHeader(fallbackHeader(source, symbol, declarationNameOffset(filePath, source, symbol.range, symbol.name)));
    return withDoc(fallback === undefined || fallback === "" ? symbol.name : fallback, "source");
  },

  layout(kind: DeclarationKind, node: { body?: unknown; children: unknown[] }): RenderLayout {
    void node;
    return LAYOUTS.get(kind) ?? "line";
  },

  globals({ filePath, source, covered }): GlobalSpan[] {
    const spans: GlobalSpan[] = [];
    for (const statement of topLevelStatements(filePath, source)) {
      const overlaps = covered.some((range) => range.start < statement.end && statement.start < range.end);
      if (overlaps) continue;
      spans.push({ range: { start: statement.start, end: statement.end }, lines: source.linesIn(statement.start, statement.end) });
    }
    return spans;
  },

  resolution: {
    signatureHelp: true,
    directCallSites(filePath: string, source: Parameters<typeof directCallSites>[1], body: ByteSpan): CallSiteCandidate[] {
      return directCallSites(filePath, source, body);
    },
  },

  isImportReference(filePath, source, range: ByteSpan): boolean {
    return isImportPosition(filePath, source, range);
  },
};

/** Collapse whitespace and drop modifiers the skeleton re-adds itself. */
export function normalizeHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const normalized = header.replace(/\s+/g, " ").replace(/^export\s+/, "").replace(/^declare\s+/, "").trim();
  return normalized === "" ? undefined : normalized;
}

function fallbackHeader(source: { slice(start: number, end: number): string }, symbol: { range: { start: number; end: number } }, nameOffset: number): string {
  const before = source.slice(symbol.range.start, nameOffset);
  const afterName = source.slice(nameOffset, symbol.range.end);
  const headerEnd = afterName.search(/[{(=]/);
  return (before + (headerEnd < 0 ? afterName : afterName.slice(0, headerEnd))).trim();
}