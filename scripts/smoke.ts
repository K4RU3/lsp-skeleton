/**
 * End-to-end smoke check: run the shared API against a real project.
 *
 * Usage: node --experimental-strip-types scripts/smoke.ts [workspace]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkspace } from "../src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = process.argv[2] ?? path.join(root, "fixtures/fixture-project");

const started = performance.now();
const scope = await createWorkspace({ root: workspace });
try {
  const opened = performance.now();
  const skeleton = await scope.engine.skeleton("src/auth/session.ts");
  const skeletonMs = performance.now();
  const deps = await scope.engine.deps("src/auth/session.ts", "SessionStore.refresh");
  const depsMs = performance.now();
  const expanded = await scope.engine.expand("src/auth/session.ts", "SessionStore.refresh");
  const expandMs = performance.now();
  const second = await scope.engine.skeleton("src/lib/impl.ts");
  const secondMs = performance.now();

  process.stdout.write(skeleton.text + "\n");
  process.stdout.write(`deps of SessionStore.refresh:\n`);
  for (const entry of deps.entries) process.stdout.write(`  ${entry.id}  ${entry.signature}\n`);
  for (const call of deps.unresolved) process.stdout.write(`  unresolved: ${call.callee} (line ${call.line})\n`);
  process.stdout.write(`\nexpanded ${expanded.function.qualifiedName}: ${expanded.text.split("\n").length} lines\n`);
  process.stdout.write(`second file symbols: ${second.symbols.length}\n\n`);

  const rows: Array<[string, number]> = [
    ["session start (initialize)", opened - started],
    ["skeleton (1st file, includes project load)", skeletonMs - opened],
    ["deps (warm)", depsMs - skeletonMs],
    ["expand (warm)", expandMs - depsMs],
    ["skeleton (2nd file, warm)", secondMs - expandMs],
  ];
  for (const [label, ms] of rows) process.stdout.write(`${label.padEnd(44)} ${ms.toFixed(0)} ms\n`);
} finally {
  scope.dispose();
}
