import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "../src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await createWorkspace({ root: path.join(root, "fixtures/fixture-project") });
try {
  const skeleton = await workspace.engine.skeleton("src/auth/session.ts");
  process.stdout.write(skeleton.text);
  const deps = await workspace.engine.deps("src/auth/session.ts", "SessionStore.refresh");
  console.log(JSON.stringify(deps.entries.map((e) => [e.id, e.signature]), null, 2));
} finally {
  workspace.dispose();
}
