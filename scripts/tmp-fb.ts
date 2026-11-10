import { startSession } from "../src/lsp/server-factory.ts";
import { QueryEngine } from "../src/core/query.ts";
import { fixtureRoot } from "../test/helpers.ts";
const session = await startSession({ workspaceRoot: fixtureRoot, readinessTimeoutMs: 60_000 });
Object.defineProperty(session, "hasCallHierarchy", { get: () => false });
const engine = new QueryEngine(session);
try {
  const u = await engine.usages("src/lib/impl.ts", "formatBytes");
  console.log(u.usages);
  const raw = await session.references("src/lib/impl.ts", 482, false);
  console.log("raw refs", raw.map(r => [r.path, r.range]));
} finally { session.dispose(); }
