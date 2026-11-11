/**
 * Language profiles: the seam between the language-independent query layer and
 * one language server's way of describing code.
 *
 * Everything language-specific enters through this interface: the launch spec,
 * the document languageId, the workspace entry file, the symbol-kind mapping,
 * where the signature comes from, whether locals belong to the symbol tree, and
 * the deps resolution strategy. Query code takes a profile; it never asks which
 * language it is looking at.
 */
import type { ServerLaunchSpec } from "../lsp/session.ts";
import type { SourceText } from "../core/source-text.ts";
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
import { rustProfile } from "./rust-profile.ts";
import { typescriptProfile } from "./typescript-profile.ts";

export interface LanguageProfile {
  /** Stable identifier, used in diagnostics and cache keys. */
  readonly id: string;
  /** Server names this profile serves. */
  readonly servers: readonly string[];
  /** File extensions (lowercase, with the dot) this profile handles. */
  readonly extensions: readonly string[];
  /**
   * Whether declarations nested inside a function-like body stay in the
   * symbol tree.
   *
   * TypeScript keeps them (the server nests local bindings and the renderer
   * never draws them, but callers may select them). Rust drops them: a 'let'
   * is not a declaration of the module and must not reach the skeleton.
   */
  readonly keepsLocals: boolean;
  /** Text put in front of an exported top-level declaration ('export '). */
  readonly exportPrefix: string;
  /**
   * Whether hover has to be asked per declaration.
   *
   * TypeScript needs it twice over: the inferred type of a const or an arrow
   * function exists only in hover, and the doc summary comes from the same
   * reply. Rust gets both from elsewhere — the resolved signature is
   * documentSymbol.detail and the doc comment is ordinary text in the file — so
   * asking would cost a round trip per symbol for nothing. Measured: hover on a
   * const costs ~6.5s with rust-analyzer 0.3.3105 (0.3.2660: ~2ms), which
   * turns one skeleton of the fixture crate into a 7-second request.
   */
  readonly wantsHover: boolean;

  /** LSP languageId for a file of this language. */
  languageId(filePath: string): string;
  /**
   * Launch spec for the server that implements this profile.
   *
   * 'resolveBin' resolves a package's bin script from this package's
   * dependencies; node-hosted servers need it, native ones ignore it.
   */
  serverSpec(resolveBin: (packageName: string, binName: string) => string): ServerLaunchSpec;
  /**
   * A file that makes the server create a workspace, so project load can be
   * observed and workspace-wide requests have a project to answer from.
   *
   * Returns undefined when the profile leaves discovery to the session.
   */
  projectEntry(workspaceRoot: string): Promise<string | undefined>;

  /**
   * Extra wait before results can be trusted, after the server's own progress
   * went quiet.
   *
   * Measured: rust-analyzer ends its first 'Fetching' token after ~220ms, while
   * the crate graph is still being built; a documentSymbol answered before that
   * returns an empty list, which would be presented as 'this file has no
   * declarations'. The profile therefore probes the server until it answers for
   * the workspace entry file (measured: ready at ~110-500ms), bounded by the
   * session's readiness budget.
   *
   * Returns false when the probe never succeeded inside the budget.
   */
  awaitWorkspaceReady?(
    session: { documentSymbols(filePath: string): Promise<unknown[]> },
    entry: string,
    timeoutMs: number,
  ): Promise<boolean>;
  /** Skeleton vocabulary of one symbol; undefined means 'not a declaration'. */
  classify(facts: ClassifyFacts): DeclarationKind | undefined;
  /** Qualified name of one declaration, given its parent's (when nested). */
  qualify(facts: SymbolFacts, parentQualifiedName: string | undefined): string;
  /** Byte offset of the declaration's name (the position hover resolves). */
  nameOffset(facts: SymbolFacts): number;
  /** Start of the whole declaration, including modifiers/docs before it. */
  declarationStart(facts: SymbolFacts): number;
  /**
   * End of the whole declaration.
   *
   * Called with facts.range already set to (declarationStart, documentSymbol's
   * end), so the profile sees the declaration it is describing.
   *
   * Usually documentSymbol's range already ends at the terminating token, but
   * not always: rust-analyzer stops a struct field at its type and leaves the
   * comma out, so expanding the field would produce a declaration that cannot
   * stand on its own. The profile is where that per-language detail belongs.
   */
  declarationEnd(facts: SymbolFacts): number;
  /** Foldable body, or undefined when the declaration has none. */
  body(facts: SymbolFacts): BodySpan | undefined;
  /** Whether the declaration is visible outside its module. */
  exported(facts: SymbolFacts): boolean;
  /**
   * Why a file can legitimately have no symbols, in this language's terms.
   *
   * Used in the readiness note when a query returns nothing: a zero answer must
   * be explained, and only the profile knows which explanations are plausible.
   */
  emptyFileExplanation: string;
  /** True when a resolved path is the language's standard library. */
  isStdlibPath(filePath: string): boolean;
  /** True when a resolved path lies outside the project (dependencies, .d.ts). */
  isExternalPath(filePath: string): boolean;
  /**
   * The note explaining that N calls went into the standard library.
   *
   * deps covers the project, not the standard library, and every language names
   * its own: TypeScript's is the 'lib.*.d.ts' family, Rust's is the std/core/
   * alloc crates. The wording lives here so the query layer never spells out a
   * file family for one language.
   */
  stdlibNote(count: number): string;
  /** Heritage clause, when the vocabulary has one. */
  heritage(facts: SymbolFacts): string | undefined;
  /** First parameter name (setters need it to render 'set x(value: T)'). */
  parameterName(facts: SymbolFacts): string | undefined;
  /** Signature, doc and rendering shape for one declaration. */
  describe(facts: SymbolFacts, hover: string | undefined): ProfileDescription;
  /**
   * How this declaration is drawn. The node's shape is available because some
   * kinds are drawn differently depending on whether they have a body.
   */
  layout(kind: DeclarationKind, node: { body?: unknown; children: unknown[] }): RenderLayout;
  /**
   * Render the lines of a 'whole' layout: the declaration text as written.
   * Defined by the profile because only it knows where the payload ends.
   */
  wholeText?(facts: SymbolFacts): string;
  /**
   * Normalise a globals span before printing. TypeScript prints the source
   * text; Rust re-indents one clause so 'use' stays readable.
   */
  renderGlobal?(filePath: string, text: string): string[];
  /** Top-level regions that no symbol covers, in source order. */
  globals(input: { filePath: string; source: SourceText; covered: ByteSpan[] }): GlobalSpan[];
  /**
   * deps/callees/usages strategy, or undefined when this language has none
   * yet (the query layer then says so instead of guessing).
   */
  resolution?: {
    /** Ask signatureHelp per call site to pick an overload (TypeScript only). */
    signatureHelp: boolean;
    /** Candidate call sites inside one body, nested closures excluded. */
    directCallSites(filePath: string, source: SourceText, body: ByteSpan): CallSiteCandidate[];
  };
  /** True when a reference range is an import/re-export position (TS only). */
  isImportReference?(filePath: string, source: SourceText, range: ByteSpan): boolean;
}

const PROFILES: readonly LanguageProfile[] = [typescriptProfile, rustProfile];

export const DEFAULT_PROFILE: LanguageProfile = typescriptProfile;

/** The profile that serves a server name (unknown names fall back to TypeScript). */
export function profileForServer(serverName: string): LanguageProfile {
  return PROFILES.find((profile) => profile.servers.includes(serverName)) ?? DEFAULT_PROFILE;
}

/** The profile for a file's extension, or undefined when unsupported. */
export function profileForPath(filePath: string): LanguageProfile | undefined {
  const extension = extensionOf(filePath);
  return PROFILES.find((profile) => profile.extensions.includes(extension));
}

/** The profile that owns a workspace, judged by the project files it declares. */
export async function profileForWorkspace(workspaceRoot: string): Promise<LanguageProfile | undefined> {
  for (const profile of PROFILES) {
    const entry = await profile.projectEntry(workspaceRoot).catch(() => undefined);
    if (entry !== undefined) return profile;
  }
  return undefined;
}

/** Lowercase extension including the dot, or "" when there is none. */
export function extensionOf(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  return dot <= slash ? "" : filePath.slice(dot).toLowerCase();
}

export { rustProfile, typescriptProfile };
export type { ClassifyFacts, DeclarationKind, ProfileDescription, RenderLayout, SymbolFacts };