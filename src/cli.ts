#!/usr/bin/env node
/**
 * Minimal CLI over the shared query API (used for manual verification and by
 * the MCP adapter's smoke checks). Not a milestone deliverable by itself.
 */
import path from "node:path";

import { createWorkspace, type ServerName } from "./index.ts";

const USAGE = `Usage:
  lsp-skeleton skeleton <file>
  lsp-skeleton expand <file> <symbol>
  lsp-skeleton deps <file> <symbol>
  lsp-skeleton usages <file> <symbol>
  lsp-skeleton callees <file> <symbol>
  lsp-skeleton search <query>

Options:
  --root <dir>    workspace root (default: cwd)
  --server <name> typescript-language-server | vtsls | rust-analyzer
  --json          print the raw result object
  --cache <dir>   persist skeletons in <dir> (shared across runs)
`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  root: string;
  server: string | undefined;
  cacheDirectory: string | undefined;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let root = process.cwd();
  let server: string | undefined;
  let cacheDirectory: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      root = path.resolve(argv[++index] ?? root);
    } else if (arg === "--server") {
      server = argv[++index];
    } else if (arg === "--cache") {
      cacheDirectory = argv[++index];
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { command: positional.shift(), positional, root, server, cacheDirectory, json };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command;
  if (command === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const workspace = await createWorkspace({
    root: args.root,
    ...(args.server === undefined ? {} : { server: args.server as ServerName }),
    ...(args.cacheDirectory === undefined ? {} : { cacheDirectory: args.cacheDirectory }),
  });
  try {
    const [file, selector] = args.positional;
    switch (command) {
      case "skeleton": {
        if (file === undefined) throw new Error("skeleton requires a file");
        const result = await workspace.engine.skeleton(file);
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else process.stdout.write(result.text);
        return;
      }
      case "expand": {
        if (file === undefined || selector === undefined) throw new Error("expand requires <file> <symbol>");
        const result = await workspace.engine.expand(file, selector);
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else process.stdout.write(result.text);
        return;
      }
      case "deps": {
        if (file === undefined || selector === undefined) throw new Error("deps requires <file> <symbol>");
        const result = await workspace.engine.deps(file, selector);
        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        process.stdout.write(`${result.function.id}\n`);
        for (const entry of result.entries) {
          process.stdout.write(`  ${entry.external ? "[ext]" : "[in] "} ${entry.id}  ${entry.signature}\n`);
        }
        if (result.unresolved.length > 0) {
          process.stdout.write("unresolved:\n");
          for (const call of result.unresolved) process.stdout.write(`  ${call.callee} (line ${call.line}, ${call.reason})\n`);
        }
        for (const note of result.notes) process.stdout.write(`note (${note.kind}): ${note.message}\n`);
        return;
      }
      case "usages": {
        if (file === undefined || selector === undefined) throw new Error("usages requires <file> <symbol>");
        const result = await workspace.engine.usages(file, selector);
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else {
          for (const usage of result.usages) process.stdout.write(`${usage.path}:${usage.line}  ${usage.text}\n`);
          for (const note of result.notes) process.stdout.write(`note (${note.kind}): ${note.message}\n`);
        }
        return;
      }
      case "callees": {
        if (file === undefined || selector === undefined) throw new Error("callees requires <file> <symbol>");
        const result = await workspace.engine.callees(file, selector);
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else {
          for (const callee of result.callees) {
            process.stdout.write(`${callee.id}  (${callee.callSites} call site(s))\n`);
          }
        }
        return;
      }
      case "search": {
        if (file === undefined) throw new Error("search requires a query");
        const result = await workspace.engine.search(file);
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else {
          for (const hit of result.hits) process.stdout.write(`${hit.id}  ${hit.signature}\n`);
        }
        return;
      }
      default:
        process.stderr.write(`unknown command: ${command}\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    workspace.dispose();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
