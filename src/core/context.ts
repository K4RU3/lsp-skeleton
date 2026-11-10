/**
 * Shared, session-scoped context of the query layer.
 *
 * Holds the document-symbol cache and the readiness memo; every query module
 * works on top of it so that skeleton, deps, expand and usages all see the same
 * symbol identities.
 */
import type { LspSession, ReadinessReport } from "../lsp/session.ts";
import { buildSymbolTree, findSymbol, flatten, isFunctionLike, type DocumentSkeleton, type SymbolNode } from "./symbols.ts";
import type { QueryEngineOptions, QueryNote, SymbolSummary } from "./types.ts";

/** Error raised for a bad selector; carries a machine-readable code. */
export class QueryError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "QueryError";
    this.code = code;
  }
}

export class QueryContext {
  readonly #session: LspSession;
  readonly #options: QueryEngineOptions;
  readonly #trees = new Map<string, { text: string; tree: DocumentSkeleton }>();
  #readiness: ReadinessReport | undefined;

  constructor(session: LspSession, options: QueryEngineOptions = {}) {
    this.#session = session;
    this.#options = options;
  }

  get session(): LspSession {
    return this.#session;
  }

  /**
   * Wait (once) for the server to finish loading the project.
   *
   * A project exists only once a file is open, so this first makes sure the
   * workspace has one; otherwise `workspace/symbol` and friends would answer
   * from an empty program ("No Project").
   */
  async ready(): Promise<ReadinessReport> {
    if (this.#options.waitForProjectLoad === false) return { ready: true, signal: "quiet", waitedMs: 0 };
    if (this.#readiness === undefined) {
      await this.#session.ensureProjectOpen();
      this.#readiness = await this.#session.waitForProjectLoad(this.#options.readinessTimeoutMs);
    }
    return this.#readiness;
  }

  async tree(filePath: string): Promise<DocumentSkeleton> {
    const absolute = this.#session.resolvePath(filePath);
    const document = await this.#session.refreshDocument(filePath);
    const cached = this.#trees.get(absolute);
    if (cached !== undefined && cached.text === document.lines.text) return cached.tree;
    const tree = await buildSymbolTree(this.#session, filePath);
    this.#trees.set(absolute, { text: document.lines.text, tree });
    return tree;
  }

  invalidate(filePath?: string): void {
    if (filePath === undefined) {
      this.#trees.clear();
      return;
    }
    this.#trees.delete(this.#session.resolvePath(filePath));
  }

  /** Resolve a selector (id, qualified name, bare name) or fail with a hint. */
  require(tree: DocumentSkeleton, selector: string): SymbolNode {
    const node = findSymbol(tree.symbols, selector);
    if (node !== undefined) return node;
    const known = flatten(tree.symbols)
      .filter((candidate) => isFunctionLike(candidate))
      .slice(0, 12)
      .map((candidate) => candidate.qualifiedName)
      .join(", ");
    throw new QueryError(
      `symbol "${selector}" was not found in ${tree.path}${known === "" ? "" : ` (available: ${known})`}`,
      "symbol-not-found",
    );
  }
}

export function summaryOf(tree: DocumentSkeleton, node: SymbolNode): SymbolSummary {
  const line = lineAt(tree.text, node.range.start);
  const endLine = lineAt(tree.text, node.range.end);
  return {
    id: node.id,
    name: node.name,
    qualifiedName: node.qualifiedName,
    kind: node.kind,
    signature: node.signature,
    path: node.path,
    line,
    endLine,
    exported: node.exported,
    ...(node.doc === undefined ? {} : { doc: node.doc }),
  };
}

export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/** Notes that explain a weak or missing answer instead of hiding it. */
export function readinessNotes(readiness: ReadinessReport, symbolCount: number): QueryNote[] {
  if (readiness.signal === "timeout") {
    return [
      {
        kind: "readiness",
        message: `The language server did not report a finished project load within ${readiness.waitedMs}ms; results may be incomplete.`,
      },
    ];
  }
  if (readiness.signal === "disposed") {
    return [{ kind: "readiness", message: "The language server exited before the query completed." }];
  }
  if (symbolCount === 0) {
    return [
      {
        kind: "readiness",
        message:
          "The server returned no symbols for this file. That can mean an empty file, a file outside the tsconfig project, or a server that has not finished loading.",
      },
    ];
  }
  return [];
}

export function isStdlibPath(path: string): boolean {
  return /(?:^|\/)lib\.[^/]*\.d\.ts$/.test(path);
}

export function isExternalPath(path: string): boolean {
  return path.includes("node_modules/") || (path.endsWith(".d.ts") && !isStdlibPath(path));
}
