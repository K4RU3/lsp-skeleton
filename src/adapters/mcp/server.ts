#!/usr/bin/env node
/**
 * MCP adapter: exposes the shared query API as MCP tools.
 *
 * This layer only knows tool names, argument shapes and how to present the
 * result as text. Everything semantic (LSP, caching, resolution) stays in the
 * core, and the core has no dependency on the MCP SDK.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createWorkspace, type Workspace } from "../../index.ts";
import type { ServerName } from "../../lsp/server-factory.ts";

const SERVER_VALUES = ["typescript-language-server", "vtsls"] as const;

export interface McpAdapterOptions {
  /** Workspace root; defaults to MCP's rootUri, then to `process.cwd()`. */
  root?: string;
  /** Language server to use. */
  server?: ServerName;
}

/** One server process per workspace root, started lazily and reused. */
class WorkspacePool {
  readonly #workspaces = new Map<string, Promise<Workspace>>();
  readonly #server: ServerName | undefined;

  constructor(server: ServerName | undefined) {
    this.#server = server;
  }

  async get(root: string): Promise<Workspace> {
    const key = root;
    let workspace = this.#workspaces.get(key);
    if (workspace === undefined) {
      workspace = createWorkspace({
        root,
        ...(this.#server === undefined ? {} : { server: this.#server }),
      });
      this.#workspaces.set(key, workspace);
      workspace.catch(() => this.#workspaces.delete(key));
    }
    return workspace;
  }

  async dispose(): Promise<void> {
    for (const pending of this.#workspaces.values()) {
      try {
        (await pending).dispose();
      } catch {
        // already failed to start; nothing to stop
      }
    }
    this.#workspaces.clear();
  }
}

/** Build the MCP server, registering every tool against the shared core. */
export function createMcpServer(options: McpAdapterOptions = {}): {
  server: McpServer;
  pool: WorkspacePool;
  connectStdio(): Promise<void>;
} {
  const pool = new WorkspacePool(options.server ?? undefined);
  const server = new McpServer(
    { name: "lsp-skeleton", version: "0.1.0" },
    {
      instructions:
        "LSP-backed skeleton/deps/expand for TypeScript. Use skeleton first (structure and types only), then expand only the functions you need, then usages/callees to move horizontally. Results carry notes: unresolved calls and dynamic-dispatch caveats are explicit, never silent.",
    },
  );

  const rootArgument = z
    .string()
    .optional()
    .describe("Workspace root directory. Defaults to the MCP client's root, then the process cwd.");

  const fileArgument = z.string().describe("File path, relative to the workspace root.");
  const symbolArgument = z
    .string()
    .describe("Symbol selector: function id (path#name@hash), qualified name (Class.method), or bare name.");

  const defaultRoot = options.root;

  const resolveRoot = async (root: string | undefined): Promise<string> => {
    const chosen = root ?? defaultRoot;
    if (chosen === undefined) return process.cwd();
    return chosen;
  };

  server.registerTool(
    "skeleton",
    {
      title: "File skeleton",
      description:
        "Return the structure of one TypeScript/JavaScript file: signatures (checker-resolved, including inferred return types), type definitions, top-level statements and folded bodies with line counts. Bodies are replaced by a line-count comment.",
      inputSchema: {
        file: fileArgument,
        root: rootArgument,
        docs: z.boolean().optional().describe("Include JSDoc summaries (default true)."),
      },
    },
    async ({ file, root, docs }) => {
      const workspace = await pool.get(await resolveRoot(root));
      const result = await workspace.engine.skeleton(file, docs === undefined ? undefined : { docs });
      return { content: [{ type: "text", text: withNotes(result.text, result.notes) }] };
    },
  );

  server.registerTool(
    "expand",
    {
      title: "Expand a function",
      description:
        "Return one declaration with its body, cut from the source by the server's own declaration range. Use after skeleton, only for the functions you need.",
      inputSchema: { file: fileArgument, symbol: symbolArgument, root: rootArgument },
    },
    async ({ file, symbol, root }) => {
      const workspace = await pool.get(await resolveRoot(root));
      const result = await workspace.engine.expand(file, symbol);
      const header = `// ${result.function.id}\n`;
      return { content: [{ type: "text", text: header + withNotes(result.text, result.notes) }] };
    },
  );

  server.registerTool(
    "deps",
    {
      title: "Dependencies of a function",
      description:
        "Return the dependency table of one function: each dependency once, with a short id and its checker-resolved signature (the overload actually used at the call site). Calls that could not be resolved are listed separately as 'unresolved'.",
      inputSchema: { file: fileArgument, symbol: symbolArgument, root: rootArgument },
    },
    async ({ file, symbol, root }) => {
      const workspace = await pool.get(await resolveRoot(root));
      const result = await workspace.engine.deps(file, symbol);
      const lines: string[] = [];
      lines.push(`${result.function.id}`);
      lines.push(`${result.function.signature}`);
      lines.push("");
      if (result.entries.length === 0) lines.push("(no project dependencies)");
      for (const entry of result.entries) {
        const sites = entry.callSites.map((site) => `line ${site.line}`).join(", ");
        lines.push(`- ${entry.id}`);
        lines.push(`  ${entry.signature}  [${entry.external ? "external" : "project"}] at ${sites}`);
      }
      if (result.unresolved.length > 0) {
        lines.push("");
        lines.push("unresolved:");
        for (const call of result.unresolved) {
          lines.push(`- ${call.callee} (line ${call.line}, ${call.reason})`);
        }
      }
      return { content: [{ type: "text", text: withNotes(lines.join("\n"), result.notes) }] };
    },
  );

  server.registerTool(
    "usages",
    {
      title: "Usages of a function",
      description:
        "Return the call sites of one function across the workspace. Zero results carry an explicit caveat: dynamic calls and unindexed files are not visible to static analysis.",
      inputSchema: { file: fileArgument, symbol: symbolArgument, root: rootArgument },
    },
    async ({ file, symbol, root }) => {
      const workspace = await pool.get(await resolveRoot(root));
      const result = await workspace.engine.usages(file, symbol);
      const lines = result.usages.map((usage) => `${usage.path}:${usage.line}  ${usage.text}`);
      if (lines.length === 0) lines.push("(no static usages)");
      return { content: [{ type: "text", text: withNotes(lines.join("\n"), result.notes) }] };
    },
  );

  server.registerTool(
    "callees",
    {
      title: "Callees of a function",
      description: "Return the functions this function calls directly, grouped by declaration.",
      inputSchema: { file: fileArgument, symbol: symbolArgument, root: rootArgument },
    },
    async ({ file, symbol, root }) => {
      const workspace = await pool.get(await resolveRoot(root));
      const result = await workspace.engine.callees(file, symbol);
      const lines = result.callees.map(
        (callee) => `${callee.id}  (${callee.callSites} call site(s), first at line ${callee.line})`,
      );
      if (lines.length === 0) lines.push("(no direct callees)");
      return { content: [{ type: "text", text: withNotes(lines.join("\n"), result.notes) }] };
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search symbols",
      description: "Search workspace symbols by name (exact, prefix, or substring). node_modules is excluded.",
      inputSchema: {
        query: z.string().describe("Symbol name or fragment."),
        root: rootArgument,
        limit: z.number().int().positive().max(200).optional().describe("Maximum hits (default 20)."),
      },
    },
    async ({ query, root, limit }) => {
      const workspace = await pool.get(await resolveRoot(root));
      const result = await workspace.engine.search(query, limit ?? 20);
      const lines = result.hits.map((hit) => `${hit.id}  ${hit.signature}`);
      if (lines.length === 0) lines.push("(no matching symbols)");
      return { content: [{ type: "text", text: withNotes(lines.join("\n"), result.notes) }] };
    },
  );

  return {
    server,
    pool,
    async connectStdio(): Promise<void> {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}

/** Append notes below the payload so caveats travel with the result. */
function withNotes(text: string, notes: Array<{ kind: string; message: string }>): string {
  if (notes.length === 0) return text;
  const rendered = notes.map((note) => `note (${note.kind}): ${note.message}`).join("\n");
  return `${text.replace(/\s+$/, "")}\n\n${rendered}\n`;
}

/** CLI entry point: `lsp-skeleton-mcp [--root dir] [--server name]`. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let root: string | undefined;
  let server: ServerName | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") root = argv[++index];
    else if (arg === "--server") {
      const value = argv[++index];
      if (value === "typescript-language-server" || value === "vtsls") server = value;
    }
  }
  const { server: mcpServer, pool, connectStdio } = createMcpServer({
    ...(root === undefined ? {} : { root }),
    ...(server === undefined ? {} : { server }),
  });
  const shutdown = (): void => {
    void pool.dispose().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await connectStdio();
  process.stderr.write("lsp-skeleton MCP server ready on stdio\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { SERVER_VALUES };
