import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { fixtureRoot } from "./helpers.ts";

/**
 * The MCP adapter is verified end to end over its real stdio transport: the
 * client below is the same one an LLM host would use.
 */
async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      path.join(import.meta.dirname, "..", "src/adapters/mcp/server.ts"),
      "--root",
      fixtureRoot,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "lsp-skeleton-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

function textOf(result: { content?: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && "text" in block)
    .map((block) => block.text)
    .join("\n");
}

test("MCP exposes the six query tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["callees", "deps", "expand", "search", "skeleton", "usages"].sort(),
    );
    const skeleton = tools.find((tool) => tool.name === "skeleton");
    assert.ok(skeleton?.description && skeleton.description.length > 20);
  });
});

test("MCP skeleton tool returns the rendered skeleton", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "skeleton", arguments: { file: "src/auth/session.ts" } });
    const text = textOf(result as { content?: unknown });
    assert.match(text, /export class SessionStore \{/);
    assert.match(text, /refresh\(token: string\): number/);
    assert.doesNotMatch(text, /const parsed = parseInput/);
  });
});

test("MCP deps tool reports dependencies and unresolved calls", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "deps",
      arguments: { file: "src/app.ts", symbol: "main" },
    });
    const text = textOf(result as { content?: unknown });
    assert.match(text, /createFixtureDep/);
    assert.match(text, /unresolved:/);
    assert.match(text, /missingHelper/);
    assert.match(text, /note \(dynamic-dispatch\)/);
  });
});

test("MCP expand tool returns the body of one function", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "expand",
      arguments: { file: "src/auth/session.ts", symbol: "SessionStore.refresh" },
    });
    const text = textOf(result as { content?: unknown });
    assert.match(text, /this.lastSize = numeric;/);
  });
});

test("MCP search tool finds project symbols", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "search", arguments: { query: "SessionStore" } });
    const text = textOf(result as { content?: unknown });
    assert.match(text, /SessionStore/);
    assert.doesNotMatch(text, /node_modules/);
  });
});
