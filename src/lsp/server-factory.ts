/**
 * Server launch specs: the only place that knows which executable implements
 * the language server, and how to start it.
 *
 * Swapping servers (or later, swapping the transport for a socket) happens
 * here and in the session layer; the query layer takes a session, not a name.
 *
 * A server name selects a language profile, and the profile owns the launch
 * spec. That keeps 'which executable, which arguments' next to 'how this
 * language is described', instead of scattering both across the tree.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { profileForServer, type LanguageProfile } from "../languages/profile.ts";
import { LspSession, type ServerLaunchSpec, type SessionOptions } from "./session.ts";

const require = createRequire(import.meta.url);

export const SERVER_NAMES = ["typescript-language-server", "vtsls", "rust-analyzer"] as const;
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

/** Launch spec for the TypeScript servers (they are launched through node). */
function typescriptSpec(name: ServerName): ServerLaunchSpec {
  switch (name) {
    case "typescript-language-server":
      return {
        name,
        command: process.execPath,
        args: [resolveEntry("typescript-language-server", "typescript-language-server"), "--stdio"],
        initializationOptions: { hostInfo: "lsp-skeleton" },
      };
    case "vtsls":
      return {
        name,
        // vtsls reads the transport from argv; without --stdio it refuses to start.
        command: process.execPath,
        args: [resolveEntry("@vtsls/language-server", "vtsls"), "--stdio"],
        initializationOptions: { hostInfo: "lsp-skeleton" },
      };
    default:
      throw new Error(`no TypeScript launch spec for ${name}`);
  }
}

/** Launch spec for one of the supported servers. */
export function serverSpec(name: ServerName = DEFAULT_SERVER): ServerLaunchSpec {
  const profile = profileForServer(name);
  // vtsls shares the TypeScript profile but has its own package and arguments.
  if (name === "vtsls") return typescriptSpec(name);
  return { ...profile.serverSpec(resolveEntry), name };
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
  const name = options.server ?? DEFAULT_SERVER;
  const profile: LanguageProfile = profileForServer(name);
  const sessionOptions: SessionOptions = {
    server: serverSpec(name),
    workspaceRoot: options.workspaceRoot,
    language: profile,
    ...(options.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: options.initializeTimeoutMs }),
    ...(options.readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: options.readinessTimeoutMs }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  };
  return LspSession.start(sessionOptions);
}
