/**
 * Shared vocabulary of the language-profile layer.
 *
 * A profile is the only place that knows how one language's server describes
 * declarations: how LSP symbol kinds map to skeleton words, whether the
 * signature comes from 'detail' or from 'hover', what counts as a local
 * binding, and how a file's top-level statements are found.
 *
 * The query layer consumes these shapes through the profile interface, so no
 * query module branches on a language name.
 */
import type { SourceText } from "../core/source-text.ts";
import type { SessionSymbol } from "../lsp/session.ts";

/**
 * The skeleton's declaration vocabulary.
 *
 * The first group is the original TypeScript vocabulary. The second group
 * exists so Rust declarations keep their own words ('pub struct Room', not
 * 'class Room'); rendering is driven by {@link RenderLayout}, not by these
 * names.
 */
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
  | "struct"
  | "union"
  | "trait"
  | "impl"
  | "module"
  | "const"
  | "static"
  | "macro"
  | "unknown";

/**
 * How a declaration is drawn.
 *
 * - 'whole': the declaration text as written (TypeScript interfaces, enums
 *   and type aliases keep their payload verbatim).
 * - 'block': a header line, its members indented, and a closing brace.
 * - 'line': a single signature line with the body folded.
 */
export type RenderLayout = "whole" | "block" | "line";

/** A half-open byte span. */
export interface ByteSpan {
  start: number;
  end: number;
}

/** The foldable body of a declaration. */
export interface BodySpan {
  /** Byte offset where the body starts. */
  start: number;
  /** Byte offset just past the body. */
  end: number;
  /** Number of source lines the body occupies. */
  lines: number;
  /** True when the declaration has an expression body instead of a block. */
  expression: boolean;
}

/** A call-site candidate: the callee expression and the enclosing call. */
export interface CallSiteCandidate {
  /** Byte offset of the callee expression. */
  calleeStart: number;
  /** Byte offset just past the callee expression. */
  calleeEnd: number;
  /** Byte offset of the whole call expression. */
  callStart: number;
  callEnd: number;
  /** Source text of the callee, e.g. 'this.notifier.notify'. */
  calleeText: string;
  /** True for a constructor call ('new X(...)' in TypeScript). */
  isNew: boolean;
  /** 1-based line of the callee. */
  line: number;
}

/** Where a signature came from: the server's resolution or the source text. */
export interface SignatureResult {
  signature: string;
  source: "checker" | "source";
}

/** Facts about one documentSymbol entry, before its kind is known. */
export interface ClassifyFacts {
  /** Workspace-relative POSIX path. */
  filePath: string;
  source: SourceText;
  /** The raw entry from textDocument/documentSymbol. */
  symbol: SessionSymbol;
  /** Kind of the enclosing declaration, when nested. */
  parentKind?: DeclarationKind;
}

/** Facts about one declaration, after classification. */
export interface SymbolFacts extends ClassifyFacts {
  /** The classified kind of this declaration. */
  kind: DeclarationKind;
  /** Byte offset of the name the server will recognise. */
  nameOffset: number;
  /** Byte range of the whole declaration. */
  range: ByteSpan;
}

/** What a profile extracts from one declaration. */
export interface ProfileDescription {
  signature: SignatureResult;
  /** Doc summary, when the language has one. */
  doc?: string;
  /**
   * Additional overloads the server mentioned. Always 0 for a language without
   * overloading; TypeScript reports '(+N overloads)' and needs it to decide
   * whether a call site's selected signature differs from the declaration's.
   */
  overloads: number;
}

/** A top-level region that no symbol covers (imports, 'use' clauses, globals). */
export interface GlobalSpan {
  range: ByteSpan;
  lines: number;
}

/** One rendered line of a global span. */
export type GlobalLine = string;
