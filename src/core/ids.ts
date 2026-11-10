/**
 * Function ids: `relativePath#qualifiedName@hash6`.
 *
 * The id is stable across renames of *callers* and across sessions: it is
 * derived only from the file, the qualified name and the checker-resolved
 * signature. Changing the signature changes the id, which is the point — an
 * id always names one overload with one type.
 *
 * The declaration kind participates in the hash so that a getter and a setter
 * (same name, same resolved type string) get distinct ids.
 */
import { createHash } from "node:crypto";

export interface FunctionId {
  path: string;
  qualifiedName: string;
  hash: string;
}

/** Collapse whitespace; hashing is insensitive to layout, not to meaning. */
export function normalizeSignature(signature: string): string {
  return signature.replace(/\s+/g, " ").trim();
}

/**
 * Canonical form of a signature for hashing.
 *
 * The same declaration is described differently by each LSP surface: hover
 * says `function parse(input: string): string`, signature help says
 * `parseInput(input: string): string` (the local alias), and a variable says
 * `const f: (x: T) => R`. Canonicalising here keeps one declaration on one id
 * regardless of which surface reported it.
 */
export function canonicalSignature(signature: string, qualifiedName: string): string {
  let text = normalizeSignature(signature);
  text = text.replace(/^export\s+/, "").replace(/^declare\s+/, "");
  text = text.replace(/^function\s+/, "").replace(/^(const|let|var)\s+/, "");
  // Replace the leading declared name (which may be an alias or a receiver
  // chain) with the canonical qualified name.
  const leading = /^([\w$]+(?:\.[\w$]+)*)/.exec(text);
  if (leading?.[1] !== undefined) {
    const rest = text.slice(leading[1].length);
    text = qualifiedName + rest;
  }
  return text;
}

/** First 6 hex characters of SHA-256 over the canonical signature. */
export function signatureHash(signature: string, qualifiedName: string, kind = ""): string {
  const canonical = canonicalSignature(signature, qualifiedName);
  return createHash("sha256").update(`${kind}\u0000${canonical}`).digest("hex").slice(0, 6);
}

/** Build the canonical id string. */
export function formatFunctionId(path: string, qualifiedName: string, signature: string, kind = ""): string {
  return `${path}#${qualifiedName}@${signatureHash(signature, qualifiedName, kind)}`;
}

/** Parse an id, tolerating a missing hash (accepts `path#name`). */
export function parseFunctionId(id: string): FunctionId {
  const hashAt = id.lastIndexOf("@");
  const hash = hashAt < 0 ? "" : id.slice(hashAt + 1);
  const rest = hashAt < 0 ? id : id.slice(0, hashAt);
  const nameAt = rest.indexOf("#");
  if (nameAt < 0) return { path: "", qualifiedName: rest, hash };
  return { path: rest.slice(0, nameAt), qualifiedName: rest.slice(nameAt + 1), hash };
}
