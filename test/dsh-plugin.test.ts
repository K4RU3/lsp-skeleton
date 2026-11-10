import test from "node:test";
import assert from "node:assert/strict";

import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";

import * as plugin from "../src/adapters/dsh/plugin.ts";
import { fixtureRoot } from "./helpers.ts";

/**
 * The DeepSeek Harness plugin is exercised against a real Cordis context and
 * the real `ToolRuntime`: tools are registered through the registry and
 * invoked with `ctx.tools.execute`, which is the path the agent loop uses.
 * Only `workingDirectory` is a stand-in (the real one would pull in the whole
 * session/projection stack).
 */
async function withHarness(run: (ctx: Context) => Promise<void>): Promise<void> {
  const ctx = new Context();
  ctx.plugin(SystemPrompt, {});
  ctx.plugin(ToolRuntime, {});
  ctx.provide("workingDirectory", {
    ensure: async () => fixtureRoot,
    get: () => fixtureRoot,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Load the plugin through the registry so its disposer is scoped to a fiber
  // and tears down the language-server sessions when the test ends.
  const fiber = ctx.plugin(plugin as never, {});
  await fiber;
  try {
    await run(ctx);
  } finally {
    await fiber.dispose();
  }
}

interface HarnessTools {
  schemas(): Array<{ name: string }>;
  execute(input: Record<string, unknown>): Promise<{
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  }>;
}

function toolsOf(ctx: Context): HarnessTools {
  return (ctx as unknown as { tools: HarnessTools }).tools;
}

/** Execute one tool through the registry and return its rendered text. */
async function runTool(ctx: Context, toolName: string, args: Record<string, unknown>): Promise<string> {
  const result = await toolsOf(ctx).execute({
    callId: "test-call",
    name: toolName,
    arguments: args,
    agent: { id: "test-agent" },
    signal: new AbortController().signal,
  });
  assert.notEqual(result.isError, true, `${toolName} failed`);
  return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

test("the plugin registers its tools on a real harness context", async () => {
  await withHarness(async (ctx) => {
    const names = toolsOf(ctx)
      .schemas()
      .map((schema) => schema.name)
      .filter((toolName) => toolName.startsWith("lsp_"))
      .sort();
    assert.deepEqual(names, ["lsp_callees", "lsp_deps", "lsp_expand", "lsp_search", "lsp_skeleton", "lsp_usages"]);
    assert.equal(plugin.name, "lsp-skeleton");
    assert.deepEqual([...plugin.inject].sort(), ["tools", "workingDirectory"]);
  });
});

test("lsp_skeleton returns the rendered skeleton through the registry", async () => {
  await withHarness(async (ctx) => {
    const text = await runTool(ctx, "lsp_skeleton", { file: "src/auth/session.ts" });
    assert.match(text, /export class SessionStore \{/);
    assert.match(text, /refresh\(token: string\): number/);
    assert.doesNotMatch(text, /const parsed = parseInput/);
  });
});

test("lsp_deps renders the dependency table with unresolved calls", async () => {
  await withHarness(async (ctx) => {
    const text = await runTool(ctx, "lsp_deps", { file: "src/app.ts", symbol: "main" });
    assert.match(text, /createFixtureDep/);
    assert.match(text, /unresolved:/);
    assert.match(text, /missingHelper/);
    assert.match(text, /note \(dynamic-dispatch\)/);
  });
});

test("lsp_expand renders one function body", async () => {
  await withHarness(async (ctx) => {
    const text = await runTool(ctx, "lsp_expand", { file: "src/auth/session.ts", symbol: "SessionStore.refresh" });
    assert.match(text, /this.lastSize = numeric;/);
  });
});

test("lsp_usages explains an empty result", async () => {
  await withHarness(async (ctx) => {
    const text = await runTool(ctx, "lsp_usages", { file: "src/app.ts", symbol: "neverCalled" });
    assert.match(text, /no static usages/);
    assert.match(text, /does NOT mean the function is never called/);
  });
});
