/**
 * Server launch specs: the only place that knows which executable implements
 * the language server, and how to start it.
 *
 * Swapping servers (or later, swapping the transport for a socket) happens
 * here and in the session layer; the query layer takes a session, not a name.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { LspSession, type ServerLaunchSpec, type SessionOptions } from "./session.ts";

const require = createRequire(import.meta.url);

export const SERVER_NAMES = ["typescript-language-server", "vtsls"] as const;
export type ServerName = (typeof SERVER_NAMES)[number];

export const DEFAULT_SERVER: ServerName = "typescript-language-server";

/** Resolve a server's entry script from this package's dependencies. */
function resolveEntry(packageName: string, subpath: string): string {
  // Resolve through the package's own manifest: `exports` may or may not
  // expose the bin script, and the bin path is implementation detail.
  const manifestPath = require.resolve(`${packageName}/package.json`, { paths: [import.meta.dirname] });
  const manifest = require(manifestPath) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[subpath];
  if (bin === undefined) throw new Error(`${packageName} does not declare a bin entry`);
  return path.resolve(path.dirname(manifestPath), bin);
}

/** Launch spec for one of the supported servers. */
export function serverSpec(name: ServerName = DEFAULT_SERVER): ServerLaunchSpec {
  switch (name) {
    case "typescript-language-server": {
      return {
        name,
        command: process.execPath,
        args: [resolveEntry("typescript-language-server", "typescript-language-server"), "--stdio"],
        initializationOptions: { hostInfo: "lsp-skeleton" },
      };
    }
    case "vtsls": {
      return {
        name,
        command: process.execPath,
        // vtsls reads the transport from argv; without --stdio it refuses to start.
        args: [resolveEntry("@vtsls/language-server", "vtsls"), "--stdio"],
        initializationOptions: { hostInfo: "lsp-skeleton" },
      };
    }
  }
}

export interface StartSessionOptions {
  workspaceRoot: string;
  server?: ServerName;
  initializeTimeoutMs?: number;
  readinessTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** Start a session for a workspace with the requested (or default) server. */
export async function startSession(options: StartSessionOptions): Promise<LspSession> {
  const spec = serverSpec(options.server ?? DEFAULT_SERVER);
  const sessionOptions: SessionOptions = {
    server: spec,
    workspaceRoot: options.workspaceRoot,
    ...(options.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: options.initializeTimeoutMs }),
    ...(options.readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: options.readinessTimeoutMs }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  };
  return LspSession.start(sessionOptions);
}
