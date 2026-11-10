/**
 * JSON-RPC 2.0 + LSP base-protocol framing over a byte duplex stream.
 *
 * This module knows about Content-Length headers and JSON, but nothing about
 * LSP methods. The session layer is the only consumer.
 */
import type { Readable, Writable } from "node:stream";

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: RpcError;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export interface DuplexTransport {
  send(message: RpcMessage): void;
  onMessage(handler: (message: RpcMessage) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const CONTENT_LENGTH = "content-length:";

/** JSON-RPC transport over a pair of already-connected streams. */
export class StreamTransport implements DuplexTransport {
  readonly #output: Writable;
  #buffer: Buffer = Buffer.alloc(0);
  #messageHandlers: Array<(message: RpcMessage) => void> = [];
  #closeHandlers: Array<(error?: Error) => void> = [];
  #closed = false;

  constructor(input: Readable, output: Writable) {
    this.#output = output;
    input.on("data", (chunk: Buffer) => {
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    input.on("error", (error) => this.#finish(error));
    input.on("close", () => this.#finish());
    output.on("error", (error) => this.#finish(error));
    output.on("close", () => this.#finish());
  }

  send(message: RpcMessage): void {
    if (this.#closed) return;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.#output.write(Buffer.concat([header, body]));
  }

  onMessage(handler: (message: RpcMessage) => void): void {
    this.#messageHandlers.push(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    this.#closeHandlers.push(handler);
  }

  close(): void {
    this.#finish();
  }

  #finish(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of this.#closeHandlers) handler(error);
  }

  #drain(): void {
    for (;;) {
      const headerEnd = this.#buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) return;
      const headerText = this.#buffer.subarray(0, headerEnd).toString("ascii");
      let contentLength = -1;
      for (const line of headerText.split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        if (line.slice(0, separator).trim().toLowerCase() === CONTENT_LENGTH.slice(0, -1)) {
          contentLength = Number.parseInt(line.slice(separator + 1).trim(), 10);
        }
      }
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        this.#finish(new Error(`invalid LSP header: ${JSON.stringify(headerText)}`));
        return;
      }
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.#buffer.length < bodyStart + contentLength) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + contentLength);
      this.#buffer = this.#buffer.subarray(bodyStart + contentLength);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch (error) {
        this.#finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const handler of this.#messageHandlers) handler(parsed as RpcMessage);
    }
  }
}
