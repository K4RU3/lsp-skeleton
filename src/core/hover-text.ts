/**
 * Turns LSP hover markup into a signature and a doc summary.
 *
 * Hover is presentation text, not structured data, so this parsing lives here
 * (inside the query layer) and never leaks to callers: everything outside sees
 * plain `signature` and `doc` strings.
 */

export interface ParsedHover {
  /** Signature line(s) without TS decorations like `(method)` or `(+2 overloads)`. */
  signature: string;
  /** Doc comment summary that followed the fenced signature, if any. */
  doc?: string;
  /** Number of additional overloads the server mentioned. */
  overloads: number;
  /** TS's own label for the symbol, e.g. `method`, `getter`, `function`. */
  label?: string;
}

const DECORATION = /^(\((?:method|property|getter|setter|constructor|function|class|interface|type alias|enum|enum member|parameter|const|let|var|alias|local|module|namespace)\)\s*)/;

/** Parse one hover payload (markdown or plaintext). */
export function parseHover(markdown: string): ParsedHover | undefined {
  const text = markdown.trim();
  if (text === "") return undefined;
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```\s*([\s\S]*)$/.exec(text);
  const body = fence?.[1] ?? text;
  const tail = fence?.[2]?.trim() ?? "";
  const lines = body.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return undefined;
  const firstLine = lines[0]?.trim() ?? "";
  if (firstLine === "" || firstLine === "(") {
    // The servers emit an empty first line before the fenced block.
    return undefined;
  }
  const decoration = DECORATION.exec(firstLine);
  const label = decoration?.[1]?.slice(1, -1).trim();
  let signatureBody = decoration === null ? firstLine : firstLine.slice(decoration[0].length);
  let overloads = 0;
  const overloadMatch = /\s*\(\+(\d+) overloads?\)\s*$/.exec(signatureBody);
  if (overloadMatch !== null) {
    overloads = Number.parseInt(overloadMatch[1] ?? "0", 10);
    signatureBody = signatureBody.slice(0, overloadMatch.index);
  }
  if (lines.length > 1) signatureBody = lines.join("\n");
  const result: ParsedHover = { signature: signatureBody, overloads };
  if (label !== undefined) result.label = label;
  if (tail !== "") result.doc = tail.split(/\n\s*\n/)[0]?.trim() ?? tail;
  return result;
}

/** Drop the `Receiver.` qualifier TS prepends to member signatures. */
export function stripReceiver(signature: string, qualifiedName: string): string {
  const dot = qualifiedName.lastIndexOf(".");
  if (dot < 0) return signature;
  const receiver = qualifiedName.slice(0, dot);
  const prefix = `${receiver}.`;
  return signature.startsWith(prefix) ? signature.slice(prefix.length) : signature;
}
