/**
 * §8: measure both language servers before choosing a default.
 *
 * For each server: start time, project load time, whether callHierarchy is
 * advertised, whether outgoingCalls actually returns anything, and the
 * granularity of documentSymbol.
 *
 * Usage: node --experimental-strip-types scripts/probe-servers.ts [workspace]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_NAMES, startSession, type ServerName } from "../src/lsp/server-factory.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = process.argv[2] ?? path.join(root, "fixtures/fixture-project");
const targetFile = "src/auth/session.ts";

interface ProbeResult {
  server: ServerName;
  serverInfo: string;
  initializeMs: number;
  loadMs: number;
  readiness: string;
  callHierarchyCapability: boolean;
  outgoingCalls: number;
  outgoingNames: string[];
  documentSymbols: number;
  topLevel: string[];
  hoverMs: number;
  hoverSnippet: string;
  definitionMs: number;
  definitionCount: number;
  incomingCalls: number;
}

async function probe(server: ServerName): Promise<ProbeResult> {
  const start = performance.now();
  const session = await startSession({ workspaceRoot: workspace, server, readinessTimeoutMs: 120_000 });
  const initialized = performance.now();
  try {
    const document = await session.openDocument(targetFile);
    const readiness = await session.waitForProjectLoad();
    const loaded = performance.now();
    const symbols = await session.documentSymbols(targetFile);
    const methodOffset = document.lines.text.indexOf("refresh(");
    const hoverStart = performance.now();
    const hover = await session.hover(targetFile, methodOffset);
    const hoverMs = performance.now() - hoverStart;
    const definitionStart = performance.now();
    const definitions = await session.definitions(targetFile, methodOffset);
    const definitionMs = performance.now() - definitionStart;

    let outgoingNames: string[] = [];
    let incoming = 0;
    if (session.hasCallHierarchy) {
      const items = await session.prepareCallHierarchy(targetFile, methodOffset);
      const item = items[0];
      if (item !== undefined) {
        const outgoing = await session.outgoingCalls(item);
        outgoingNames = outgoing.map((call) => `${call.item.name}@${call.item.path === null ? "?" : path.basename(call.item.path)}`);
        incoming = (await session.incomingCalls(item)).length;
      }
    }
    return {
      server,
      serverInfo: `${session.serverInfo?.name ?? "?"} ${session.serverInfo?.version ?? ""}`,
      initializeMs: Math.round(initialized - start),
      loadMs: Math.round(loaded - initialized),
      readiness: `${readiness.signal} ready=${String(readiness.ready)}`,
      callHierarchyCapability: session.hasCallHierarchy,
      outgoingCalls: outgoingNames.length,
      outgoingNames,
      documentSymbols: countSymbols(symbols),
      topLevel: symbols.map((symbol) => `${symbol.name}(${symbol.kind})`),
      hoverMs: Math.round(hoverMs),
      hoverSnippet: (hover?.markdown ?? "").split("\n").slice(0, 3).join(" / "),
      definitionMs: Math.round(definitionMs),
      definitionCount: definitions.length,
      incomingCalls: incoming,
    };
  } finally {
    session.dispose();
  }
}

function countSymbols(symbols: Array<{ children: unknown[] }>): number {
  let total = 0;
  for (const symbol of symbols) {
    total += 1 + countSymbols(symbol.children as Array<{ children: unknown[] }>);
  }
  return total;
}

const results: ProbeResult[] = [];
for (const server of SERVER_NAMES) {
  process.stderr.write(`probing ${server}...\n`);
  try {
    results.push(await probe(server));
  } catch (error) {
    results.push({
      server,
      serverInfo: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      initializeMs: -1,
      loadMs: -1,
      readiness: "error",
      callHierarchyCapability: false,
      outgoingCalls: 0,
      outgoingNames: [],
      documentSymbols: 0,
      topLevel: [],
      hoverMs: -1,
      hoverSnippet: "",
      definitionMs: -1,
      definitionCount: 0,
      incomingCalls: 0,
    });
  }
}

console.log(JSON.stringify({ workspace, targetFile, results }, null, 2));
