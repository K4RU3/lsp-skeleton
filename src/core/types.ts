/**
 * Result shapes of the semantic query API.
 *
 * These types are the contract between the shared core and every adapter
 * (MCP, DeepSeek Harness, CLI). They contain no LSP vocabulary and no
 * adapter-specific formatting.
 */
import type { SymbolNode } from "./symbols.ts";

export interface QueryNote {
  kind: "readiness" | "dynamic-dispatch" | "unresolved" | "fallback" | "stdlib" | "truncated";
  /** Human-readable; meant to be shown next to the data. */
  message: string;
}

export interface SymbolSummary {
  id: string;
  name: string;
  qualifiedName: string;
  kind: SymbolNode["kind"];
  /** Checker-resolved signature. */
  signature: string;
  path: string;
  /** 1-based first line of the declaration. */
  line: number;
  /** 1-based last line of the declaration. */
  endLine: number;
  exported: boolean;
  doc?: string;
}

export interface SkeletonResponse {
  path: string;
  /** The rendered skeleton, ready to print. */
  text: string;
  symbols: SymbolSummary[];
  exports: string[];
  notes: QueryNote[];
}

export interface DependencyEntry {
  /** Canonical id: `path#qualifiedName@hash6`. */
  id: string;
  name: string;
  qualifiedName: string;
  path: string;
  /** Signature of the overload selected at the call site. */
  signature: string;
  kind: SymbolNode["kind"];
  /** True when the declaration lives in node_modules or another .d.ts. */
  external: boolean;
  /** Call sites of this dependency inside the scanned function. */
  callSites: Array<{ line: number; text: string }>;
  doc?: string;
}

export interface UnresolvedCall {
  callee: string;
  /** 1-based line inside the scanned function. */
  line: number;
  reason: "no-definition" | "no-hover";
}

export interface DepsResponse {
  function: SymbolSummary;
  entries: DependencyEntry[];
  unresolved: UnresolvedCall[];
  notes: QueryNote[];
}

export interface CalleesResponse {
  function: SymbolSummary;
  callees: Array<{ id: string; name: string; path: string; line: number; callSites: number }>;
  notes: QueryNote[];
}

export interface ExpandResponse {
  function: SymbolSummary;
  /** Source text of the whole declaration, body included. */
  text: string;
  notes: QueryNote[];
}

export interface UsagesResponse {
  function: SymbolSummary;
  usages: Array<{ path: string; line: number; text: string }>;
  notes: QueryNote[];
}

export interface SearchHit extends SymbolSummary {
  score: number;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  notes: QueryNote[];
}

export interface QueryEngineOptions {
  /** Wait for project load before the first query (default true). */
  waitForProjectLoad?: boolean;
  /** Readiness budget per query, in milliseconds. */
  readinessTimeoutMs?: number;
}
