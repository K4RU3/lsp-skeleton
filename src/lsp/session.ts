/**
 * LspSession: one workspace, one language-server process, thrown away freely.
 *
 * The session owns the transport, the initialize/ability negotiation, request
 * ids, document synchronisation, position conversion and process cleanup.
 * It exposes LSP-shaped operations in byte offsets; callers above this layer
 * never see line/character positions or JSON-RPC.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DocumentStore, filePathOf, readTextOrUndefined, uriOfFile, type OpenDocument } from "./documents.ts";
import {
  SymbolKind,
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type DocumentSymbol,
  type Hover,
  type InitializeResult,
  type Location,
  type Range,
  type ServerCapabilities,
  type SignatureHelp,
  type SymbolInformation,
} from "./protocol.ts";
import { StreamTransport, type RpcMessage } from "./transport.ts";

/** Describes how to launch a language server for one workspace. */
export interface ServerLaunchSpec {
  /** Stable identifier used in diagnostics, e.g. `typescript-language-server`. */
  name: string;
  /** Executable to spawn. */
  command: string;
  /** Arguments, e.g. `["--stdio"]`. */
  args: string[];
  /** Extra environment for the child process. */
  env?: Record<string, string>;
  /** `initializationOptions` payload. */
  initializationOptions?: unknown;
}

/** A range expressed in byte offsets into the document text. */
export interface ByteRange {
  start: number;
  end: number;
}

/** A document symbol with byte ranges; children follow the server's nesting. */
export interface SessionSymbol {
  name: string;
  detail?: string;
  kind: number;
  deprecated?: boolean;
  range: ByteRange;
  selectionRange: ByteRange;
  children: SessionSymbol[];
}

/** A definition/reference/call location, resolved to absolute paths. */
export interface SessionLocation {
  uri: string;
  path: string | null;
  range: ByteRange;
}

/** A call-hierarchy item usable as an identity token across calls. */
export interface SessionCallItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  path: string | null;
  range: ByteRange;
  selectionRange: ByteRange;
  data?: unknown;
}

export interface HoverResult {
  /** Raw hover markup, unparsed; interpretation belongs to the query layer. */
  markdown: string;
  range?: ByteRange;
}

/** Whether the server's project load was observed, or assumed. */
export interface ReadinessReport {
  ready: boolean;
  /** `progress`: load observed and finished. `quiet`: no load was pending. */
  signal: "progress" | "quiet" | "timeout" | "disposed";
  waitedMs: number;
}

export interface SessionEvents {
  onNotification?(method: string, params: unknown): void;
  onProgress?(event: {
    token: string;
    kind: "begin" | "report" | "end";
    title?: string;
    message?: string;
  }): void;
  onStderr?(chunk: string): void;
  onExit?(code: number | null, signal: string | null): void;
}

export interface SessionOptions {
  server: ServerLaunchSpec;
  workspaceRoot: string;
  /** Milliseconds to wait for `initialize` before failing. */
  initializeTimeoutMs?: number;
  /** Milliseconds to wait for project loading after the first open. */
  readinessTimeoutMs?: number;
  /** Milliseconds a single request may take. */
  requestTimeoutMs?: number;
  events?: SessionEvents;
}

export class LspError extends Error {
  readonly code: number | undefined;
  readonly method: string;
  constructor(message: string, method: string, code?: number) {
    super(message);
    this.name = "LspError";
    this.method = method;
    this.code = code;
  }
}

const DEFAULTS = {
  initializeTimeoutMs: 60_000,
  readinessTimeoutMs: 60_000,
  requestTimeoutMs: 120_000,
} as const;

/** Maps a filesystem path to the languageId the servers expect. */
export function languageIdForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".tsx":
      return "typescriptreact";
    case ".jsx":
      return "javascriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    default:
      return "typescript";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
  timer: NodeJS.Timeout;
}

interface ProgressState {
  /** Titles per active token. */
  active: Map<string, string | undefined>;
  /** Tokens observed since session start (proves the server reported loading). */
  seen: Set<string>;
  /** Notified whenever progress state changes. */
  listeners: Array<() => void>;
  /** True after at least one cycle has begun and ended. */
  completedCycle: boolean;
  /** Monotonic count of `begin` events, for quiescence checks. */
  begins: number;
}

/** One running language server bound to one workspace. */
export class LspSession {
  readonly #options: SessionOptions;
  readonly #initializeTimeoutMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #workspaceRoot: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #transport: StreamTransport;
  readonly #documents = new DocumentStore();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #progress: ProgressState = {
    active: new Map(),
    seen: new Set(),
    listeners: [],
    completedCycle: false,
    begins: 0,
  };
  #nextId = 1;
  #capabilities: ServerCapabilities = {};
  #serverInfo: { name: string; version?: string } | undefined;
  #disposed = false;
  #readiness: Promise<ReadinessReport> | undefined;
  #stderr = "";

  private constructor(options: SessionOptions, child: ChildProcessWithoutNullStreams) {
    this.#options = options;
    this.#initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULTS.initializeTimeoutMs;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULTS.readinessTimeoutMs;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    this.#child = child;
    this.#transport = new StreamTransport(child.stdout, child.stdin);
    this.#transport.onMessage((message) => this.#handleMessage(message));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-16_384);
      this.#options.events?.onStderr?.(chunk);
    });
    child.on("exit", (code, signal) => {
      this.#options.events?.onExit?.(code, signal);
      this.#failAllPending(
        new LspError(
          `language server exited (code=${String(code)}, signal=${String(signal)})${this.#stderrTail()}`,
          "session",
        ),
      );
    });
  }

  /** Spawn a server and complete the initialize/initialized handshake. */
  static async start(options: SessionOptions): Promise<LspSession> {
    const child = spawn(options.server.command, options.server.args, {
      cwd: options.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.server.env },
    }) as ChildProcessWithoutNullStreams;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
    });
    const session = new LspSession(options, child);
    try {
      await spawned;
      await session.#initialize();
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }

  get serverName(): string {
    return this.#options.server.name;
  }

  get workspaceRoot(): string {
    return this.#workspaceRoot;
  }

  get capabilities(): ServerCapabilities {
    return this.#capabilities;
  }

  get serverInfo(): { name: string; version?: string } | undefined {
    return this.#serverInfo;
  }

  get hasCallHierarchy(): boolean {
    return this.#capabilities.callHierarchyProvider !== undefined && this.#capabilities.callHierarchyProvider !== false;
  }

  get hasDocumentSymbol(): boolean {
    return this.#capabilities.documentSymbolProvider !== undefined && this.#capabilities.documentSymbolProvider !== false;
  }

  get hasHover(): boolean {
    return this.#capabilities.hoverProvider !== undefined && this.#capabilities.hoverProvider !== false;
  }

  get hasDefinition(): boolean {
    return this.#capabilities.definitionProvider !== undefined && this.#capabilities.definitionProvider !== false;
  }

  get hasSignatureHelp(): boolean {
    return this.#capabilities.signatureHelpProvider !== undefined && this.#capabilities.signatureHelpProvider !== false;
  }

  /** Path -> URI, relative inputs resolved against the workspace root. */
  uriForPath(filePath: string): string {
    return uriOfFile(path.resolve(this.#workspaceRoot, filePath));
  }

  /** Absolute path of a URI or workspace-relative path. */
  resolvePath(filePath: string): string {
    return path.resolve(this.#workspaceRoot, filePath);
  }

  /** Relative path (POSIX separators) of an absolute path, for ids and output. */
  relativePath(absolute: string): string {
    const relative = path.relative(this.#workspaceRoot, absolute);
    return (relative === "" ? path.basename(absolute) : relative).split(path.sep).join("/");
  }

  /** Open (or focus) a document, reading it from disk when necessary. */
  async openDocument(filePath: string): Promise<OpenDocument> {
    const absolute = this.resolvePath(filePath);
    const uri = uriOfFile(absolute);
    const existing = this.#documents.get(uri);
    if (existing !== undefined) return existing;
    const text = await readFile(absolute, "utf8");
    const document = this.#didOpen(uri, text, languageIdForPath(absolute));
    this.invalidateReadiness();
    return document;
  }

  /** Re-read a document from disk and push a full-text `didChange`. */
  async refreshDocument(filePath: string): Promise<OpenDocument> {
    const absolute = this.resolvePath(filePath);
    const uri = uriOfFile(absolute);
    const text = await readFile(absolute, "utf8");
    const existing = this.#documents.get(uri);
    if (existing === undefined) {
      const document = this.#didOpen(uri, text, languageIdForPath(absolute));
      this.invalidateReadiness();
      return document;
    }
    if (existing.lines.text === text) return existing;
    const document = this.#documents.set({ uri, languageId: existing.languageId, text });
    this.#notify("textDocument/didChange", {
      textDocument: { uri, version: document.version },
      contentChanges: [{ text }],
    });
    return document;
  }

  closeDocument(filePath: string): void {
    const uri = this.uriForPath(filePath);
    if (this.#documents.get(uri) === undefined) return;
    this.#documents.delete(uri);
    this.#notify("textDocument/didClose", { textDocument: { uri } });
  }

  /** The text of an open document, or of a file on disk. */
  async textForUri(uri: string): Promise<string | undefined> {
    const open = this.#documents.get(uri);
    if (open !== undefined) return open.lines.text;
    const filePath = filePathOf(uri);
    if (filePath === null) return undefined;
    return readTextOrUndefined(filePath);
  }

  /**
   * Wait until the server has finished loading the project that the most
   * recent `openDocument` belongs to. The result says which signal was used,
   * so callers can refuse to present an empty answer as authoritative.
   */
  async waitForProjectLoad(timeoutMs?: number): Promise<ReadinessReport> {
    this.#readiness ??= this.#awaitProjectLoad(timeoutMs ?? this.#readinessTimeoutMs);
    return this.#readiness;
  }

  /** Drop the readiness memo so the next query waits for a fresh load. */
  invalidateReadiness(): void {
    this.#readiness = undefined;
  }

  async documentSymbols(filePath: string): Promise<SessionSymbol[]> {
    const document = await this.openDocument(filePath);
    const raw = await this.#request<DocumentSymbol[] | SymbolInformation[] | null>(
      "textDocument/documentSymbol",
      { textDocument: { uri: document.uri } },
    );
    return this.#symbolsFrom(raw, document);
  }

  async hover(filePath: string, byteOffset: number): Promise<HoverResult | undefined> {
    const document = await this.openDocument(filePath);
    const raw = await this.#request<Hover | null>("textDocument/hover", {
      textDocument: { uri: document.uri },
      position: document.lines.positionAtByte(byteOffset),
    });
    if (raw === null || raw === undefined) return undefined;
    const range = raw.range === undefined ? undefined : this.#byteRange(document, raw.range);
    return range === undefined ? { markdown: hoverToMarkdown(raw) } : { markdown: hoverToMarkdown(raw), range };
  }

  async definitions(filePath: string, byteOffset: number): Promise<SessionLocation[]> {
    const document = await this.openDocument(filePath);
    const raw = await this.#request<Location | Location[] | null>("textDocument/definition", {
      textDocument: { uri: document.uri },
      position: document.lines.positionAtByte(byteOffset),
    });
    return this.#locations(raw);
  }

  async references(filePath: string, byteOffset: number, includeDeclaration = true): Promise<SessionLocation[]> {
    const document = await this.openDocument(filePath);
    const raw = await this.#request<Location[] | null>("textDocument/references", {
      textDocument: { uri: document.uri },
      position: document.lines.positionAtByte(byteOffset),
      context: { includeDeclaration },
    });
    return this.#locations(raw);
  }

  async prepareCallHierarchy(filePath: string, byteOffset: number): Promise<SessionCallItem[]> {
    const document = await this.openDocument(filePath);
    const raw = await this.#request<CallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", {
      textDocument: { uri: document.uri },
      position: document.lines.positionAtByte(byteOffset),
    });
    return this.#callItems(raw);
  }

  async outgoingCalls(item: SessionCallItem): Promise<Array<{ item: SessionCallItem; fromRanges: ByteRange[] }>> {
    const raw = await this.#request<CallHierarchyOutgoingCall[] | null>("callHierarchy/outgoingCalls", {
      item: await this.#toWireItem(item),
    });
    // `fromRanges` are positions inside the *caller* (the item we sent), not
    // inside the callee; converting them against the callee's document would
    // silently produce wrong offsets.
    const callerDocument = await this.#documentForUri(item.uri);
    const result: Array<{ item: SessionCallItem; fromRanges: ByteRange[] }> = [];
    for (const call of raw ?? []) {
      const to = await this.#mapWireItem(call.to);
      result.push({
        item: to,
        fromRanges:
          callerDocument === undefined ? [] : call.fromRanges.map((range) => this.#byteRange(callerDocument, range)),
      });
    }
    return result;
  }

  async incomingCalls(item: SessionCallItem): Promise<Array<{ item: SessionCallItem; fromRanges: ByteRange[] }>> {
    const raw = await this.#request<CallHierarchyIncomingCall[] | null>("callHierarchy/incomingCalls", {
      item: await this.#toWireItem(item),
    });
    const result: Array<{ item: SessionCallItem; fromRanges: ByteRange[] }> = [];
    for (const call of raw ?? []) {
      const from = await this.#mapWireItem(call.from);
      // Incoming call sites live in the *caller*'s file (`call.from`).
      const document = await this.#documentForUri(call.from.uri);
      result.push({
        item: from,
        fromRanges:
          document === undefined ? [] : call.fromRanges.map((range) => this.#byteRange(document, range)),
      });
    }
    return result;
  }

  async workspaceSymbols(query: string): Promise<SessionCallItem[]> {
    const raw = await this.#request<SymbolInformation[] | null>("workspace/symbol", { query });
    const items: SessionCallItem[] = [];
    for (const symbol of raw ?? []) {
      const mapped = await this.#mapWireItem({
        name: symbol.name,
        kind: symbol.kind,
        uri: symbol.location.uri,
        range: symbol.location.range,
        selectionRange: symbol.location.range,
        ...(symbol.containerName === undefined ? {} : { detail: symbol.containerName }),
      });
      items.push(mapped);
    }
    return items;
  }

  /** Signature help at a byte offset; used to resolve the selected overload. */
  async signatureHelp(filePath: string, byteOffset: number): Promise<SignatureHelp | undefined> {
    const document = await this.openDocument(filePath);
    const raw = await this.#request<SignatureHelp | null>("textDocument/signatureHelp", {
      textDocument: { uri: document.uri },
      position: document.lines.positionAtByte(byteOffset),
      context: { triggerKind: 1, isRetrigger: false },
    });
    return raw ?? undefined;
  }

  /**
   * Make sure the server has a project to answer workspace-wide queries.
   *
   * tsserver only creates a project after a file is opened. Workspace symbol
   * search (and any other workspace-level request) fails with "No Project"
   * until then, which would surface as a server error rather than an answer.
   */
  async ensureProjectOpen(): Promise<void> {
    if (this.#documents.values().length > 0) return;
    const entry = await this.#findProjectEntry();
    if (entry === undefined) return;
    await this.openDocument(entry);
  }

  /** First file included by the workspace's tsconfig/jsconfig, if any. */
  async #findProjectEntry(): Promise<string | undefined> {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const configPath = path.join(this.#workspaceRoot, name);
      const text = await readTextOrUndefined(configPath);
      if (text === undefined) continue;
      const { parseJsonConfigFileContent, readConfigFile, sys } = await import("typescript");
      const parsed = readConfigFile(configPath, sys.readFile);
      const contents = parseJsonConfigFileContent(parsed.config, sys, this.#workspaceRoot);
      const first = contents.fileNames.find((file) => !file.endsWith(".d.ts"));
      if (first !== undefined) return first;
    }
    return undefined;
  }

  /** Byte range of `range` in the document identified by `uri`. */
  async byteRangeOf(uri: string, range: Range): Promise<ByteRange | undefined> {
    const document = await this.#documentForUri(uri);
    if (document === undefined) return undefined;
    return this.#byteRange(document, range);
  }

  /** Current text of a document identified by URI (open or on disk). */
  async documentText(uri: string): Promise<string | undefined> {
    return this.textForUri(uri);
  }

  /** The text of a document, opening it if needed; used for source slices. */
  async documentLines(uri: string): Promise<OpenDocument | undefined> {
    return this.#documentForUri(uri);
  }

  get openDocumentCount(): number {
    return this.#documents.values().length;
  }

  /** Diagnostic snapshot for probes and error messages. */
  get progressSnapshot(): { active: string[]; completedCycle: boolean; seen: number; begins: number } {
    return {
      active: [...this.#progress.active.values()].filter((value): value is string => value !== undefined),
      completedCycle: this.#progress.completedCycle,
      seen: this.#progress.seen.size,
      begins: this.#progress.begins,
    };
  }

  get sawProgress(): boolean {
    return this.#progress.seen.size > 0;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#transport.close();
    this.#failAllPending(new LspError("session disposed", "session"));
    try {
      this.#notify("exit", undefined);
    } catch {
      // the pipe may already be gone
    }
    try {
      this.#child.stdin.end();
    } catch {
      // ignore
    }
    this.#child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL");
    }, 1500);
    timer.unref();
  }

  // ---------------------------------------------------------------- internals

  async #initialize(): Promise<void> {
    const result = await this.#request<InitializeResult>(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "lsp-skeleton", version: "0.1.0" },
        rootUri: pathToFileURL(this.#workspaceRoot).href,
        rootPath: this.#workspaceRoot,
        workspaceFolders: [{ uri: pathToFileURL(this.#workspaceRoot).href, name: path.basename(this.#workspaceRoot) }],
        capabilities: {
          workspace: {
            workspaceFolders: true,
            configuration: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
            symbol: {},
          },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: {},
            references: {},
            callHierarchy: { dynamicRegistration: false },
          },
          window: { workDoneProgress: true },
        },
        initializationOptions: this.#options.server.initializationOptions ?? {},
      },
      this.#initializeTimeoutMs,
    );
    this.#capabilities = result.capabilities;
    this.#serverInfo = result.serverInfo;
    this.#notify("initialized", {});
  }

  #notify(method: string, params: unknown): void {
    const message = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.#transport.send(message as RpcMessage);
  }

  #request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.#disposed) return Promise.reject(new LspError("session disposed", method));
    const id = this.#nextId++;
    const effectiveTimeout = timeoutMs ?? this.#requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new LspError(`request timed out after ${effectiveTimeout}ms: ${method}`, method));
      }, effectiveTimeout);
      timer.unref();
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        method,
        timer,
      });
      this.#transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #handleMessage(message: RpcMessage): void {
    if ("id" in message && !("method" in message)) {
      const pending = this.#pending.get(Number(message.id));
      if (pending === undefined) return;
      this.#pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if ("error" in message && message.error !== undefined) {
        pending.reject(new LspError(message.error.message, pending.method, message.error.code));
      } else {
        pending.resolve((message as { result?: unknown }).result);
      }
      return;
    }
    if (!("method" in message)) return;
    if ("id" in message) {
      this.#handleServerRequest(message.id, message.method, "params" in message ? message.params : undefined);
      return;
    }
    this.#handleNotification(message.method, "params" in message ? message.params : undefined);
  }

  #handleServerRequest(id: number | string, method: string, params: unknown): void {
    const respond = (result: unknown): void => {
      this.#transport.send({ jsonrpc: "2.0", id, result } as RpcMessage);
    };
    const fail = (message: string): void => {
      this.#transport.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message },
      } as RpcMessage);
    };
    switch (method) {
      case "workspace/configuration": {
        const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
        respond(items.map(() => ({})));
        return;
      }
      case "workspace/workspaceFolders":
        respond([{ uri: pathToFileURL(this.#workspaceRoot).href, name: path.basename(this.#workspaceRoot) }]);
        return;
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
        respond(null);
        return;
      case "workspace/applyEdit":
        respond({ applied: false, failureReason: "lsp-skeleton is read-only" });
        return;
      case "window/showDocument":
        respond({ success: false });
        return;
      default:
        fail(`unsupported server request: ${method}`);
    }
  }

  #handleNotification(method: string, params: unknown): void {
    this.#options.events?.onNotification?.(method, params);
    if (method === "$/progress") {
      const payload = params as
        | { token: string | number; value: { kind: string; title?: string; message?: string } }
        | undefined;
      if (payload === undefined) return;
      const token = String(payload.token);
      const value = payload.value;
      if (value.kind === "begin") {
        this.#progress.active.set(token, value.title);
        this.#progress.seen.add(token);
        this.#progress.begins += 1;
      } else if (value.kind === "end") {
        this.#progress.active.delete(token);
        this.#progress.completedCycle = true;
      }
      this.#options.events?.onProgress?.({
        token,
        kind: value.kind as "begin" | "report" | "end",
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.message === undefined ? {} : { message: value.message }),
      });
      for (const listener of this.#progress.listeners) listener();
    }
  }

  async #awaitProjectLoad(timeoutMs: number): Promise<ReadinessReport> {
    const started = Date.now();
    if (this.#disposed) return { ready: false, signal: "disposed", waitedMs: 0 };
    // Give the server a moment to announce loading; the progress begin may
    // arrive only after the first didOpen has been processed.
    await this.#waitForProgress(() => this.#progress.begins > 0, Math.min(3000, timeoutMs));
    const observed = this.#progress.begins > 0;
    if (!observed) {
      // No progress support: wait out a quiescence window so a slow server
      // still has a chance to answer, but report that nothing was observed.
      await sleep(Math.min(750, timeoutMs));
      return { ready: !this.#disposed, signal: "quiet", waitedMs: Date.now() - started };
    }
    const settled = await this.#waitForQuiescence(timeoutMs - (Date.now() - started), 150);
    return {
      ready: settled && !this.#disposed,
      signal: settled ? "progress" : "timeout",
      waitedMs: Date.now() - started,
    };
  }

  /** Wait until no progress is active and no new one began for `quietMs`. */
  async settle(quietMs = 150, timeoutMs = this.#readinessTimeoutMs): Promise<ReadinessReport> {
    const started = Date.now();
    const settled = await this.#waitForQuiescence(timeoutMs, quietMs);
    return {
      ready: settled && !this.#disposed,
      signal: this.#disposed ? "disposed" : settled ? "progress" : "timeout",
      waitedMs: Date.now() - started,
    };
  }

  async #waitForQuiescence(timeoutMs: number, quietMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastBegins = -1;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (this.#progress.begins !== lastBegins) {
        lastBegins = this.#progress.begins;
        quietSince = Date.now();
      }
      if (this.#progress.active.size === 0 && Date.now() - quietSince >= quietMs) return true;
      await sleep(25);
    }
    return this.#progress.active.size === 0;
  }

  #waitForProgress(predicate: () => boolean, timeoutMs: number): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const listener = (): void => {
        if (!predicate()) return;
        clearTimeout(timer);
        const index = this.#progress.listeners.indexOf(listener);
        if (index >= 0) this.#progress.listeners.splice(index, 1);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.#progress.listeners.indexOf(listener);
        if (index >= 0) this.#progress.listeners.splice(index, 1);
        resolve();
      }, timeoutMs);
      timer.unref();
      this.#progress.listeners.push(listener);
    });
  }

  #didOpen(uri: string, text: string, languageId: string): OpenDocument {
    const document = this.#documents.set({ uri, languageId, text, version: 1 });
    this.#notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: document.version, text },
    });
    return document;
  }

  async #documentForUri(uri: string): Promise<OpenDocument | undefined> {
    const existing = this.#documents.get(uri);
    if (existing !== undefined) return existing;
    const filePath = filePathOf(uri);
    if (filePath === null) return undefined;
    const text = await readTextOrUndefined(filePath);
    if (text === undefined) return undefined;
    return this.#didOpen(uri, text, languageIdForPath(filePath));
  }

  #symbolsFrom(raw: DocumentSymbol[] | SymbolInformation[] | null, document: OpenDocument): SessionSymbol[] {
    if (raw === null || raw === undefined || raw.length === 0) return [];
    const first = raw[0] as DocumentSymbol | SymbolInformation;
    if ("location" in first) {
      return (raw as SymbolInformation[]).map((symbol) => {
        const range = this.#byteRange(document, symbol.location.range);
        return {
          name: symbol.name,
          kind: symbol.kind,
          range,
          selectionRange: range,
          children: [],
          ...(symbol.containerName === undefined ? {} : { detail: symbol.containerName }),
        };
      });
    }
    const convert = (symbol: DocumentSymbol): SessionSymbol => ({
      name: symbol.name,
      kind: symbol.kind,
      range: this.#byteRange(document, symbol.range),
      selectionRange: this.#byteRange(document, symbol.selectionRange),
      children: (symbol.children ?? []).map(convert),
      ...(symbol.detail === undefined ? {} : { detail: symbol.detail }),
      ...(symbol.deprecated === true ? { deprecated: true } : {}),
    });
    return (raw as DocumentSymbol[]).map(convert);
  }

  #byteRange(document: OpenDocument, range: Range): ByteRange {
    return {
      start: document.lines.byteOffsetAt(range.start),
      end: document.lines.byteOffsetAt(range.end),
    };
  }

  async #locations(raw: Location | Location[] | null): Promise<SessionLocation[]> {
    if (raw === null || raw === undefined) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const result: SessionLocation[] = [];
    for (const location of list) {
      const document = await this.#documentForUri(location.uri);
      if (document === undefined) {
        result.push({ uri: location.uri, path: filePathOf(location.uri), range: { start: 0, end: 0 } });
        continue;
      }
      result.push({
        uri: location.uri,
        path: filePathOf(location.uri),
        range: this.#byteRange(document, location.range),
      });
    }
    return result;
  }

  #callItems(raw: CallHierarchyItem[] | null): SessionCallItem[] {
    return (raw ?? []).map((item) => this.#wireToCallItem(item));
  }

  #wireToCallItem(item: CallHierarchyItem): SessionCallItem {
    const document = this.#documents.get(item.uri);
    const convert = (range: Range): ByteRange =>
      document === undefined ? { start: range.start.line, end: range.end.line } : this.#byteRange(document, range);
    return {
      name: item.name,
      kind: item.kind,
      uri: item.uri,
      path: filePathOf(item.uri),
      range: convert(item.range),
      selectionRange: convert(item.selectionRange),
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      ...(item.data === undefined ? {} : { data: item.data }),
    };
  }

  async #mapWireItem(item: CallHierarchyItem): Promise<SessionCallItem> {
    await this.#documentForUri(item.uri);
    return this.#wireToCallItem(item);
  }

  async #toWireItem(item: SessionCallItem): Promise<CallHierarchyItem> {
    const document = await this.#documentForUri(item.uri);
    const toWire = (range: ByteRange): Range =>
      document === undefined
        ? { start: { line: range.start, character: 0 }, end: { line: range.end, character: 0 } }
        : { start: document.lines.positionAtByte(range.start), end: document.lines.positionAtByte(range.end) };
    return {
      name: item.name,
      kind: item.kind,
      uri: item.uri,
      range: toWire(item.range),
      selectionRange: toWire(item.selectionRange),
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      ...(item.data === undefined ? {} : { data: item.data }),
    };
  }

  #failAllPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #stderrTail(): string {
    const tail = this.#stderr.trim();
    return tail === "" ? "" : `: ${tail.split("\n").slice(-5).join(" | ")}`;
  }
}

function hoverToMarkdown(hover: Hover): string {
  const contents = hover.contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((entry) => (typeof entry === "string" ? entry : entry.value)).join("\n\n");
  }
  return contents.value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export { SymbolKind };
export type { CallHierarchyItem, DocumentSymbol, Location, Range };
