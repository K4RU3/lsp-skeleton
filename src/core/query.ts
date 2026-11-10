/**
 * The semantic query API: skeleton, expand, deps, callees, usages, search.
 *
 * Callers of this module never see LSP method names, positions or JSON-RPC.
 * Capability differences between servers are absorbed inside the resolver:
 * `callHierarchy` when available, `definition` + hover otherwise.
 *
 * Answers never guess: each outgoing call either becomes a dependency entry
 * with a checker-resolved signature, or shows up as unresolved, or is counted
 * as a standard-library call that deps does not cover.
 */
import type { LspSession } from "../lsp/session.ts";
import { QueryContext, QueryError, lineAt, readinessNotes, summaryOf } from "./context.ts";
import { collectOutgoingCalls, resolveCall } from "./dependency-resolution.ts";
import { renderSkeleton, type SkeletonOptions } from "./skeleton.ts";
import { flatten, isFunctionLike, type DocumentSkeleton, type SymbolNode } from "./symbols.ts";
import type {
  CalleesResponse,
  DependencyEntry,
  DepsResponse,
  ExpandResponse,
  QueryEngineOptions,
  QueryNote,
  SearchHit,
  SearchResponse,
  SkeletonResponse,
  SymbolSummary,
  UnresolvedCall,
  UsagesResponse,
} from "./types.ts";

export class QueryEngine {
  readonly #context: QueryContext;

  constructor(session: LspSession, options: QueryEngineOptions = {}) {
    this.#context = new QueryContext(session, options);
  }

  get session(): LspSession {
    return this.#context.session;
  }

  /** Wait for the server's project load; the readiness signal is public. */
  ready() {
    return this.#context.ready();
  }

  /** M1: the skeleton of one file. */
  async skeleton(filePath: string, options?: SkeletonOptions): Promise<SkeletonResponse> {
    const readiness = await this.#context.ready();
    const tree = await this.#context.tree(filePath);
    const exports = exportNames(tree.symbols);
    const rendered = renderSkeleton({
      path: tree.path,
      text: tree.text,
      symbols: tree.symbols,
      globals: tree.globals,
      exports,
      ...(options === undefined ? {} : { options }),
    });
    return {
      path: tree.path,
      text: rendered.text,
      symbols: flatten(tree.symbols).map((node) => summaryOf(tree, node)),
      exports,
      notes: readinessNotes(readiness, tree.symbols.length),
    };
  }

  /** Symbols of one file, without rendering. */
  async listSymbols(filePath: string): Promise<SymbolSummary[]> {
    await this.#context.ready();
    const tree = await this.#context.tree(filePath);
    return flatten(tree.symbols).map((node) => summaryOf(tree, node));
  }

  /** M3: the full declaration, body included, cut by documentSymbol's range. */
  async expand(filePath: string, selector: string): Promise<ExpandResponse> {
    const readiness = await this.#context.ready();
    const tree = await this.#context.tree(filePath);
    const node = this.#context.require(tree, selector);
    return {
      function: summaryOf(tree, node),
      text: tree.text.slice(node.range.start, node.range.end).replace(/\s+$/, "") + "\n",
      notes: readinessNotes(readiness, 1),
    };
  }

  /** M2: dependency table + unresolved list for one function. */
  async deps(filePath: string, selector: string): Promise<DepsResponse> {
    const readiness = await this.#context.ready();
    const tree = await this.#context.tree(filePath);
    const node = this.#context.require(tree, selector);
    const report = await collectOutgoingCalls(this.#context.session, node, tree);
    const entries = new Map<string, DependencyEntry>();
    const unresolved: UnresolvedCall[] = [];
    let stdlib = 0;
    for (const call of report.calls) {
      const resolution = await resolveCall(this.#context.session, call);
      if (resolution.kind === "unresolved") {
        unresolved.push(resolution.unresolved);
        continue;
      }
      if (resolution.kind === "stdlib") {
        stdlib += 1;
        continue;
      }
      for (const entry of resolution.entries) {
        const existing = entries.get(entry.id);
        if (existing === undefined) entries.set(entry.id, entry);
        else existing.callSites.push(...entry.callSites);
      }
    }
    const notes: QueryNote[] = [...readinessNotes(readiness, 1)];
    notes.push({
      kind: "dynamic-dispatch",
      message:
        "Dependencies are the calls the checker resolved statically. Callbacks, event handlers, DI and higher-order functions can hide dependencies; the table is not a proof of completeness.",
    });
    if (!report.usedCallHierarchy) {
      notes.push({
        kind: "fallback",
        message: this.#context.session.hasCallHierarchy
          ? "callHierarchy returned no item for this declaration; outgoing calls were resolved from call sites via definition."
          : "The server does not advertise callHierarchy; outgoing calls were resolved from call sites via definition.",
      });
    }
    if (report.nestedSites > 0) {
      notes.push({
        kind: "dynamic-dispatch",
        message: `${report.nestedSites} call site(s) inside nested closures were attributed to the closure, not to this function.`,
      });
    }
    if (stdlib > 0) {
      notes.push({
        kind: "stdlib",
        message: `${stdlib} call(s) to the standard library (lib.*.d.ts) were omitted as out of scope for deps.`,
      });
    }
    if (unresolved.length > 0) {
      notes.push({
        kind: "unresolved",
        message: `${unresolved.length} call(s) could not be resolved and are listed under "unresolved"; they are not silently dropped.`,
      });
    }
    return { function: summaryOf(tree, node), entries: [...entries.values()], unresolved, notes };
  }

  /** Direct callees, grouped by declaration (a cheap horizontal move). */
  async callees(filePath: string, selector: string): Promise<CalleesResponse> {
    const readiness = await this.#context.ready();
    const tree = await this.#context.tree(filePath);
    const node = this.#context.require(tree, selector);
    const report = await collectOutgoingCalls(this.#context.session, node, tree);
    const grouped = new Map<string, CalleesResponse["callees"][number]>();
    for (const call of report.calls) {
      const resolution = await resolveCall(this.#context.session, call);
      if (resolution.kind !== "resolved") continue;
      for (const entry of resolution.entries) {
        const existing = grouped.get(entry.id);
        if (existing === undefined) {
          grouped.set(entry.id, {
            id: entry.id,
            name: entry.name,
            path: entry.path,
            line: entry.callSites[0]?.line ?? 1,
            callSites: entry.callSites.length,
          });
        } else {
          existing.callSites += entry.callSites.length;
        }
      }
    }
    return { function: summaryOf(tree, node), callees: [...grouped.values()], notes: readinessNotes(readiness, 1) };
  }

  /** Who calls this function; 0 results always come with the caveat. */
  async usages(filePath: string, selector: string): Promise<UsagesResponse> {
    const session = this.#context.session;
    const readiness = await this.#context.ready();
    const tree = await this.#context.tree(filePath);
    const node = this.#context.require(tree, selector);
    const usages: UsagesResponse["usages"] = [];
    const notes: QueryNote[] = [...readinessNotes(readiness, 1)];
    if (session.hasCallHierarchy) {
      const items = await session.prepareCallHierarchy(node.path, node.nameOffset);
      const item = items[0];
      if (item !== undefined) {
        for (const call of await session.incomingCalls(item)) {
          const callerPath = call.item.path;
          if (callerPath === null) continue;
          const callerDocument = await session.documentLines(call.item.uri);
          for (const range of call.fromRanges) {
            usages.push({
              path: session.relativePath(callerPath),
              line: callerDocument === undefined ? 1 : callerDocument.lines.positionAtByte(range.start).line + 1,
              text: callerDocument === undefined ? "" : callerDocument.lines.text.slice(range.start, range.end),
            });
          }
        }
      }
    } else {
      notes.push({
        kind: "fallback",
        message: "The server does not advertise callHierarchy; usages came from textDocument/references.",
      });
      for (const reference of await session.references(node.path, node.nameOffset, false)) {
        if (reference.path === null) continue;
        const document = await session.documentLines(reference.uri);
        usages.push({
          path: session.relativePath(reference.path),
          line: document === undefined ? 1 : document.lines.positionAtByte(reference.range.start).line + 1,
          text: document === undefined ? "" : document.lines.text.slice(reference.range.start, reference.range.end),
        });
      }
    }
    if (usages.length === 0) {
      notes.push({
        kind: "dynamic-dispatch",
        message:
          "0 usages does NOT mean the function is never called. Dynamic calls (callbacks, event handlers, DI, string-based registration) are invisible to static analysis, and files outside the project index are not searched.",
      });
    }
    return { function: summaryOf(tree, node), usages: dedupeUsages(usages), notes };
  }

  /** Workspace symbol search, restricted to project files. */
  async search(query: string, limit = 50): Promise<SearchResponse> {
    const session = this.#context.session;
    const readiness = await this.#context.ready();
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    for (const item of await session.workspaceSymbols(query)) {
      if (hits.length >= limit) break;
      if (item.path === null) continue;
      const relative = session.relativePath(item.path);
      if (isExternal(relative)) continue;
      const score = scoreOf(item.name, needle);
      if (score === 0) continue;
      if (hits.some((hit) => hit.name === item.name && hit.path === relative)) continue;
      let tree: DocumentSkeleton;
      try {
        tree = await this.#context.tree(relative);
      } catch {
        continue;
      }
      const node = flatten(tree.symbols).find(
        (candidate) =>
          candidate.name === item.name &&
          candidate.selectionRange.start <= item.range.end &&
          item.range.start <= candidate.selectionRange.end,
      );
      if (node === undefined) continue;
      hits.push({ ...summaryOf(tree, node), score });
    }
    hits.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return { query, hits, notes: readinessNotes(readiness, hits.length) };
  }

  /** Drop memoised trees, e.g. after an edit. */
  invalidate(filePath?: string): void {
    this.#context.invalidate(filePath);
  }
}

function isExternal(path: string): boolean {
  return path.includes("node_modules/") || path.endsWith(".d.ts");
}

function exportNames(symbols: SymbolNode[]): string[] {
  return flatten(symbols)
    .filter((node) => node.exported && !node.qualifiedName.includes("."))
    .map((node) => node.name);
}

function dedupeUsages(usages: UsagesResponse["usages"]): UsagesResponse["usages"] {
  const seen = new Set<string>();
  return usages.filter((usage) => {
    const key = `${usage.path}:${usage.line}:${usage.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreOf(name: string, needle: string): number {
  const lower = name.toLowerCase();
  if (lower === needle) return 3;
  if (lower.startsWith(needle)) return 2;
  if (lower.includes(needle)) return 1;
  return 0;
}

export { QueryError, lineAt };
export type {
  CalleesResponse,
  DependencyEntry,
  DepsResponse,
  ExpandResponse,
  QueryEngineOptions,
  QueryNote,
  SearchHit,
  SearchResponse,
  SkeletonResponse,
  SymbolSummary,
  UnresolvedCall,
  UsagesResponse,
};
export type { SkeletonOptions };
