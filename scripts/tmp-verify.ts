import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "../src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Verify against a REAL project: this repository itself.
const workspace = await createWorkspace({ root });
try {
  const skeleton = await workspace.engine.skeleton("src/core/session.ts").catch(() => undefined);
  const target = skeleton ?? (await workspace.engine.skeleton("src/lsp/session.ts"));
  console.log("skeleton of", target.path, "->", target.text.split("\n").length, "lines");
  console.log(target.text.split("\n").slice(0, 30).join("\n"));
  const deps = await workspace.engine.deps("src/core/query.ts", "QueryEngine.deps");
  console.log("\ndeps:", deps.entries.length, "entries,", deps.unresolved.length, "unresolved");
  for (const entry of deps.entries.slice(0, 10)) console.log("  ", entry.id, entry.signature.slice(0, 70));
  const usages = await workspace.engine.usages("src/core/skeleton.ts", "renderSkeleton");
  console.log("\nusages of renderSkeleton:", usages.usages.map((u) => u.path + ":" + u.line));
} finally {
  workspace.dispose();
}
