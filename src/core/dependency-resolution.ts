/**
 * Resolves the outgoing calls of one function into dependency entries.
 *
 * Two paths produce the same shape:
 *  - `callHierarchy/outgoingCalls` when the server advertises it;
 *  - syntactic call sites + `textDocument/definition` + hover otherwise.
 *
 * Call sites inside nested closures are dropped: a call in a callback belongs
 * to the callback, and attributing it to the enclosing function would report a
 * dependency that is not actually invoked by the function's own flow.
 */
import type { LspSession } from "../lsp/session.ts";
import type { LanguageProfile } from "../languages/profile.ts";
import type { CallSiteCandidate } from "../languages/types.ts";
import { formatFunctionId } from "./ids.ts";
import { symbolAtOffset, type DocumentSkeleton, type SymbolNode } from "./symbols.ts";
import type { DependencyEntry, UnresolvedCall } from "./types.ts";

export interface CallSite {
  /** Byte offset of the callee in the caller document. */
  start: number;
  end: number;
  /** 1-based line in the caller. */
  line: number;
  text: string;
}

export interface RawCall {
  callee: string;
  /** Workspace-relative path of the caller (where the call sites live). */
  callerPath: string;
  sites: CallSite[];
  /** Declaration of the callee, when the server resolved it. */
  target?: { path: string; offset: number };
}

export type CallResolution =
  | { kind: "resolved"; entries: DependencyEntry[] }
  | { kind: "unresolved"; unresolved: UnresolvedCall }
  | { kind: "stdlib" };

export interface OutgoingCallsReport {
  calls: RawCall[];
  /** Call sites dropped because they sit inside a nested closure. */
  nestedSites: number;
  /** True when the server's call hierarchy was usable. */
  usedCallHierarchy: boolean;
}

/** Collect the direct outgoing calls of a function node. */
export async function collectOutgoingCalls(
  session: LspSession,
  node: SymbolNode,
  tree: DocumentSkeleton,
): Promise<OutgoingCallsReport> {
  const body = node.body;
  if (body === undefined) return { calls: [], nestedSites: 0, usedCallHierarchy: false };
  const direct = tree.profile.resolution?.directCallSites(node.path, tree.source, body) ?? [];
  const directStarts = new Set(direct.map((site) => site.calleeStart));
  let nestedSites = 0;

  if (session.hasCallHierarchy) {
    const items = await session.prepareCallHierarchy(node.path, node.nameOffset);
    const item = items[0];
    if (item !== undefined) {
      const outgoing = await session.outgoingCalls(item);
      const calls: RawCall[] = [];
      for (const call of outgoing) {
        const seen = new Set<number>();
        const sites: CallSite[] = [];
        for (const range of call.fromRanges) {
          if (seen.has(range.start)) continue;
          seen.add(range.start);
          if (!directStarts.has(range.start)) {
            nestedSites += 1;
            continue;
          }
          sites.push({
            start: range.start,
            end: range.end,
            line: tree.source.lineAt(range.start),
            text: tree.source.slice(range.start, range.end),
          });
        }
        if (sites.length === 0) continue;
        const path = call.item.path;
        calls.push({
          callee: call.item.name,
          callerPath: node.path,
          sites,
          ...(path === null ? {} : { target: { path: session.relativePath(path), offset: call.item.selectionRange.start } }),
        });
      }
      // Call hierarchy lists only calls the checker could resolve. Every other
      // direct call site must still be reported, and it is worth one
      // `definition` request: a call into `lib.*.d.ts` is standard library (not
      // an unresolved dependency), while a truly unknown callee has no
      // definition at all.
      const covered = new Set(calls.flatMap((call) => call.sites.map((site) => site.start)));
      const uncovered = direct.filter((site) => !covered.has(site.calleeStart));
      if (uncovered.length > 0) calls.push(...(await fallbackCalls(session, node, uncovered)));
      return { calls, nestedSites, usedCallHierarchy: true };
    }
  }

  const calls = await fallbackCalls(session, node, direct);
  return { calls, nestedSites, usedCallHierarchy: false };
}

/** Capability fallback: syntactic call sites, then `definition` per site. */
async function fallbackCalls(
  session: LspSession,
  node: SymbolNode,
  sites: CallSiteCandidate[],
): Promise<RawCall[]> {
  const calls: RawCall[] = [];
  for (const site of sites) {
    const info: CallSite = {
      start: site.calleeStart,
      end: site.calleeEnd,
      line: site.line,
      text: site.calleeText,
    };
    // Resolve the *property name*, not the receiver: `a.b()` must resolve to
    // `b`, and a position at the receiver resolves to the variable instead.
    const definitions = await session.definitions(node.path, Math.max(site.calleeStart, site.calleeEnd - 1));
    const definition = definitions[0];
    if (definition?.path === undefined || definition.path === null) {
      calls.push({ callee: site.calleeText, callerPath: node.path, sites: [info] });
      continue;
    }
    calls.push({
      callee: site.calleeText,
      callerPath: node.path,
      sites: [info],
      target: { path: session.relativePath(definition.path), offset: definition.range.start },
    });
  }
  return calls;
}

/** Resolve one raw call into dependency entries (one per selected overload). */
export async function resolveCall(session: LspSession, call: RawCall, profile: LanguageProfile): Promise<CallResolution> {
  const firstSite = call.sites[0];
  const unresolved = (reason: UnresolvedCall["reason"]): CallResolution => ({
    kind: "unresolved",
    unresolved: { callee: call.callee, line: firstSite?.line ?? 1, reason },
  });
  const target = call.target;
  if (target === undefined) return unresolved("no-definition");
  if (profile.isStdlibPath(target.path)) return { kind: "stdlib" };

  // Resolve the declaration itself: it supplies the identity (name, qualified
  // name, kind) that the dependency id hashes, independently of which
  // overload each call site selected.
  const resolved = await symbolAtOffset(session, target.path, target.offset, profile);
  if (resolved === undefined) return unresolved("no-definition");
  const declared = resolved.node;
  const hover = profile.wantsHover ? await session.hover(target.path, declared.nameOffset) : undefined;
  const described = profile.describe(
    {
      filePath: declared.path,
      source: resolved.source,
      symbol: resolved.raw,
      kind: declared.kind,
      nameOffset: declared.nameOffset,
      range: declared.range,
    },
    hover?.markdown,
  );
  if (described.signature.signature === "") return unresolved("no-hover");
  const name = declared.name;
  const qualifiedName = declared.qualifiedName;
  const kind = declared.kind;
  const external = profile.isExternalPath(target.path);
  // Only a language with overloading needs per-call-site selection, and only it
  // reports a non-zero overload count.
  const overloaded = described.overloads > 0;

  const bySignature = new Map<string, DependencyEntry>();
  for (const site of call.sites) {
    let signature = described.signature.signature;
    if (overloaded && session.hasSignatureHelp) {
      // Signature help is asked from inside the argument list: that is where
      // the checker decides which overload the call selects.
      const help = await session.signatureHelp(call.callerPath, site.end + 1);
      const active = help?.signatures[help.activeSignature ?? 0]?.label;
      if (active !== undefined && active !== "") signature = active;
    }
    // Signature help labels a call with the *local alias* (`parseInput`), while
    // the declaration is named `parse`. Report the declared name so ids and
    // signatures agree with skeleton/expand.
    signature = renameSignature(signature, name);
    const entry: DependencyEntry = {
      id: formatFunctionId(target.path, qualifiedName, signature, kind),
      name,
      qualifiedName,
      path: target.path,
      signature,
      kind,
      external,
      callSites: [{ line: site.line, text: site.text }],
      ...(described.doc === undefined ? {} : { doc: described.doc }),
    };
    const existing = bySignature.get(entry.id);
    if (existing === undefined) bySignature.set(entry.id, entry);
    else existing.callSites.push({ line: site.line, text: site.text });
  }
  const entries = [...bySignature.values()];
  if (entries.length === 0) return unresolved("no-hover");
  return { kind: "resolved", entries };
}

/** Replace the declared name in a signature with `name`, keeping its shape. */
export function renameSignature(signature: string, name: string): string {
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(signature);
  if (call?.[1] !== undefined) return `${name}${signature.slice(call[1].length)}`;
  const variable = /^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:/.exec(signature);
  if (variable?.[1] !== undefined && variable[2] !== undefined) {
    return `${variable[1]} ${name}${signature.slice(variable[0].length - 1)}`;
  }
  return signature;
}