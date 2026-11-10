/**
 * lsp-skeleton: LSP-backed skeleton / deps / expand for TypeScript.
 *
 * The public surface is deliberately small and adapter-neutral:
 *  - {@link createWorkspace} starts a session and returns a query engine;
 *  - {@link QueryEngine} exposes semantic operations, never LSP details.
 */
import { startSession, type ServerName } from "./lsp/server-factory.ts";
import type { LspSession } from "./lsp/session.ts";
import { QueryEngine } from "./core/query.ts";
import type { QueryEngineOptions } from "./core/types.ts";

export { QueryEngine, QueryError } from "./core/query.ts";
export { startSession, serverSpec, DEFAULT_SERVER, SERVER_NAMES } from "./lsp/server-factory.ts";
export type { ServerName } from "./lsp/server-factory.ts";
export { LspSession, LspError } from "./lsp/session.ts";
export type { ReadinessReport } from "./lsp/session.ts";
export { formatFunctionId, parseFunctionId, signatureHash } from "./core/ids.ts";
export type { SymbolNode } from "./core/symbols.ts";
export type { SkeletonOptions } from "./core/skeleton.ts";
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
} from "./core/types.ts";

export interface WorkspaceOptions extends QueryEngineOptions {
  /** Workspace root (absolute, or relative to `process.cwd()`). */
  root: string;
  /** Language server to use; defaults to the measured default. */
  server?: ServerName;
  /** Readiness budget for the initial project load. */
  readinessTimeoutMs?: number;
}

export interface Workspace {
  session: LspSession;
  engine: QueryEngine;
  dispose(): void;
}

/**
 * Start a language server for `root` and wrap it in a query engine.
 *
 * One workspace == one session == one server process. Dispose it when done;
 * sessions are cheap and hold no persistent state.
 */
export async function createWorkspace(options: WorkspaceOptions): Promise<Workspace> {
  const session = await startSession({
    workspaceRoot: options.root,
    ...(options.server === undefined ? {} : { server: options.server }),
    ...(options.readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: options.readinessTimeoutMs }),
  });
  const engine = new QueryEngine(session, {
    ...(options.waitForProjectLoad === undefined ? {} : { waitForProjectLoad: options.waitForProjectLoad }),
    ...(options.readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: options.readinessTimeoutMs }),
    ...(options.cacheDirectory === undefined ? {} : { cacheDirectory: options.cacheDirectory }),
  });
  return {
    session,
    engine,
    dispose: () => session.dispose(),
  };
}
