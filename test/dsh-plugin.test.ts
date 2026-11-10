import test from "node:test";
import assert from "node:assert/strict";

import { apply, inject, name } from "../src/adapters/dsh/plugin.ts";
import { fixtureRoot } from "./helpers.ts";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

/**
 * The DeepSeek Harness plugin is exercised through its public surface: the
 * tool definitions it registers on `ctx.tools`. A minimal fake context stands
 * in for the harness runtime; the plugin only uses `tools.register`,
 * `effect`, and `workingDirectory.ensure`.
 */
interface FakeContext {
  tools: { register(tool: ToolDefinition): void };
  effect(callback: () => () => void): void;
  workingDirectory: { ensure(): Promise<string> };
  /** Tools registered so far, by name. */
  registered: Map<string, ToolDefinition>;
  /** Disposers installed through `ctx.effect`. */
  disposers: Array<() => void>;
}

function fakeContext(): FakeContext {
  const registered = new Map<string, ToolDefinition>();
  const disposers: Array<() => void> = [];
  return {
    tools: {
      register: (tool) => {
        registered.set(tool.name, tool);
      },
    },
    effect: (callback) => {
      disposers.push(callback());
    },
    workingDirectory: { ensure: async () => fixtureRoot },
    registered,
    disposers,
  };
}

/** A call context whose agent resolves to the fixture workspace. */
const exec = (): Parameters<ToolDefinition["execute"]>[1] => ({
  callId: "test-call",
  rootCallId: "test-call",
  token: "test-token",
  name: "test",
  arguments: {},
  agent: { id: "test-agent" },
  signal: new AbortController().signal,
  deferContext: () => undefined,
  concludeTurn: () => undefined,
});

function textOf(value: unknown): string {
  const result = value as { text?: string };
  return typeof result.text === "string" ? result.text : JSON.stringify(result);
}

/** Run one tool call and always dispose the plugin's sessions afterwards. */
async function call(
  toolName: string,
  args: Record<string, unknown>,
  check: (text: string) => void,
): Promise<void> {
  const ctx = fakeContext();
  apply(ctx as never, {});
  try {
    const tool = ctx.registered.get(toolName);
    assert.ok(tool, `${toolName} must be registered`);
    check(textOf(await tool.execute(args, exec() as never)));
  } finally {
    for (const dispose of ctx.disposers) dispose();
  }
}

test("the plugin registers the five lsp tools and declares its services", () => {
  const ctx = fakeContext();
  apply(ctx as never, {});
  assert.equal(name, "lsp-skeleton");
  assert.deepEqual([...inject].sort(), ["tools", "workingDirectory"]);
  assert.deepEqual(
    [...ctx.registered.keys()].sort(),
    ["lsp_callees", "lsp_deps", "lsp_expand", "lsp_search", "lsp_skeleton", "lsp_usages"],
  );
  for (const tool of ctx.registered.values()) {
    assert.ok(tool.output, `${tool.name} must declare output`);
    assert.equal(tool.output.schema.type, "object");
  }
  for (const dispose of ctx.disposers) dispose();
});

test("lsp_skeleton returns the rendered skeleton", async () => {
  await call("lsp_skeleton", { file: "src/auth/session.ts" }, (text) => {
    assert.match(text, /export class SessionStore \{/);
    assert.doesNotMatch(text, /const parsed = parseInput/);
  });
});

test("lsp_deps renders the dependency table with unresolved calls", async () => {
  await call("lsp_deps", { file: "src/app.ts", symbol: "main" }, (text) => {
    assert.match(text, /createFixtureDep/);
    assert.match(text, /unresolved:/);
    assert.match(text, /missingHelper/);
  });
});

test("lsp_expand renders one function body", async () => {
  await call("lsp_expand", { file: "src/auth/session.ts", symbol: "SessionStore.refresh" }, (text) => {
    assert.match(text, /this.lastSize = numeric;/);
  });
});

test("lsp_usages explains an empty result", async () => {
  await call("lsp_usages", { file: "src/app.ts", symbol: "neverCalled" }, (text) => {
    assert.match(text, /no static usages/);
    assert.match(text, /does NOT mean the function is never called/);
  });
});
