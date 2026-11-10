/**
 * DeepSeek Harness plugin adapter.
 *
 * Thin by construction: each tool translates arguments, calls the shared query
 * API, and renders the canonical value as text. Workspace scoping comes from
 * the harness's own working-directory service, so the adapter never invents
 * its own notion of "where the project is".
 */
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
// Type-only: brings the ctx.workingDirectory merge into scope.
import type {} from "@deepseek-ai/dsh-working-directory";

import { createWorkspace, type Workspace } from "../../index.ts";
import type { ServerName } from "../../lsp/server-factory.ts";
import type { QueryNote } from "../../core/types.ts";

/** Coordinator plugin name. */
export const name = "lsp-skeleton";

/** Services used by this plugin. */
export const inject = ["tools", "workingDirectory"];

/**
 * Plugin config, validated by the harness loader.
 *
 * The shape is deliberately small: everything else (file, symbol, query) is a
 * tool argument, not deployment configuration.
 */
export const Config = z.object({
  server: z
    .union(["typescript-language-server", "vtsls"])
    .default("typescript-language-server")
    .description("Language server to launch for each workspace"),
  readinessTimeoutMs: z
    .natural()
    .max(600_000)
    .default(60_000)
    .description("How long to wait for the language server's project load, in milliseconds"),
});

interface AdapterConfig {
  /** Language server to launch for each workspace. */
  server?: ServerName;
  /** Readiness budget for the initial project load, in milliseconds. */
  readinessTimeoutMs?: number;
}

/** One lazily started session per workspace root, shared by all tool calls. */
class WorkspacePool {
  readonly #workspaces = new Map<string, Promise<Workspace>>();
  readonly #config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.#config = config;
  }

  async get(root: string): Promise<Workspace> {
    let workspace = this.#workspaces.get(root);
    if (workspace === undefined) {
      workspace = createWorkspace({
        root,
        ...(this.#config.server === undefined ? {} : { server: this.#config.server }),
        ...(this.#config.readinessTimeoutMs === undefined
          ? {}
          : { readinessTimeoutMs: this.#config.readinessTimeoutMs }),
      });
      this.#workspaces.set(root, workspace);
      workspace.catch(() => this.#workspaces.delete(root));
    }
    return workspace;
  }

  async dispose(): Promise<void> {
    for (const pending of this.#workspaces.values()) {
      try {
        (await pending).dispose();
      } catch {
        // the session never started; nothing to stop
      }
    }
    this.#workspaces.clear();
  }
}

/** Render notes below a payload so caveats always travel with the result. */
function withNotes(text: string, notes: QueryNote[]): string {
  if (notes.length === 0) return text;
  return `${text.replace(/\s+$/, "")}\n\n${notes.map((note) => `note (${note.kind}): ${note.message}`).join("\n")}\n`;
}

/** Register the lsp-skeleton tools on the harness context. */
export function apply(ctx: Context, config: AdapterConfig = {}): void {
  const pool = new WorkspacePool(config);
  // Sessions are fiber-scoped: unloading the plugin (or failing startup) stops
  // every language server it started, so no child process outlives the plugin.
  ctx.effect(() => () => pool.dispose());

  /** Workspace root for one call: the session's own working directory. */
  const rootOf = async (exec: ToolRunContext): Promise<string> => {
    if (exec.agent === undefined) return process.cwd();
    return ctx.workingDirectory.ensure(exec.agent, exec.signal);
  };

  const fileParam = { type: "string", required: true, description: "File path, relative to the workspace root." } as const;
  const symbolParam = {
    type: "string",
    required: true,
    description: "Symbol selector: function id (path#name@hash), qualified name (Class.method), or bare name.",
  } as const;

  ctx.tools.register(
    defineTool({
      name: "lsp_skeleton",
      description:
        "Return the structure of one TypeScript/JavaScript file: checker-resolved signatures, type definitions, top-level statements and folded bodies with line counts. Bodies are replaced by a line-count comment.",
      parameters: { file: fileParam },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const workspace = await pool.get(await rootOf(exec));
        const result = await workspace.engine.skeleton(args.file);
        return { text: withNotes(result.text, result.notes) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "lsp_expand",
      description:
        "Return one declaration with its body, cut from the source by the language server's declaration range. Use after lsp_skeleton, only for the functions you need.",
      parameters: { file: fileParam, symbol: symbolParam },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const workspace = await pool.get(await rootOf(exec));
        const result = await workspace.engine.expand(args.file, args.symbol);
        return { text: `// ${result.function.id}\n${withNotes(result.text, result.notes)}` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "lsp_deps",
      description:
        "Return the dependency table of one function: each dependency once, with a short id and its checker-resolved signature (the overload actually used at the call site). Calls that could not be resolved are listed separately as 'unresolved'.",
      parameters: { file: fileParam, symbol: symbolParam },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const workspace = await pool.get(await rootOf(exec));
        const result = await workspace.engine.deps(args.file, args.symbol);
        const lines = [result.function.id, result.function.signature, ""];
        if (result.entries.length === 0) lines.push("(no project dependencies)");
        for (const entry of result.entries) {
          const sites = entry.callSites.map((site) => `line ${site.line}`).join(", ");
          lines.push(`- ${entry.id}`, `  ${entry.signature}  [${entry.external ? "external" : "project"}] at ${sites}`);
        }
        if (result.unresolved.length > 0) {
          lines.push("", "unresolved:");
          for (const call of result.unresolved) lines.push(`- ${call.callee} (line ${call.line}, ${call.reason})`);
        }
        return { text: withNotes(lines.join("\n"), result.notes) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "lsp_usages",
      description:
        "Return the call sites of one function across the workspace. Zero results carry an explicit caveat: dynamic calls and unindexed files are not visible to static analysis.",
      parameters: { file: fileParam, symbol: symbolParam },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const workspace = await pool.get(await rootOf(exec));
        const result = await workspace.engine.usages(args.file, args.symbol);
        const lines = result.usages.map((usage) => `${usage.path}:${usage.line}  ${usage.text}`);
        if (lines.length === 0) lines.push("(no static usages)");
        return { text: withNotes(lines.join("\n"), result.notes) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "lsp_callees",
      description: "Return the functions this function calls directly, grouped by declaration.",
      parameters: { file: fileParam, symbol: symbolParam },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const workspace = await pool.get(await rootOf(exec));
        const result = await workspace.engine.callees(args.file, args.symbol);
        const lines = result.callees.map(
          (callee) => `${callee.id}  (${callee.callSites} call site(s), first at line ${callee.line})`,
        );
        if (lines.length === 0) lines.push("(no direct callees)");
        return { text: withNotes(lines.join("\n"), result.notes) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "lsp_search",
      description: "Search workspace symbols by name (exact, prefix, or substring). node_modules is excluded.",
      parameters: {
        query: { type: "string", required: true, description: "Symbol name or fragment." },
        limit: { type: "number", description: "Maximum hits (default 20)." },
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const workspace = await pool.get(await rootOf(exec));
        const result = await workspace.engine.search(args.query, args.limit ?? 20);
        const lines = result.hits.map((hit) => `${hit.id}  ${hit.signature}`);
        if (lines.length === 0) lines.push("(no matching symbols)");
        return { text: withNotes(lines.join("\n"), result.notes) };
      },
    }),
  );
}
