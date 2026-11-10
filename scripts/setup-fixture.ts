/**
 * fixture-project の node_modules に、.d.ts 解決の検証用パッケージを作る。
 * 生成物はコミットしない（.gitignore 済み）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "fixtures/fixture-project/node_modules/fixture-lib");

await mkdir(dir, { recursive: true });
await writeFile(
  path.join(dir, "package.json"),
  JSON.stringify({ name: "fixture-lib", version: "1.0.0", types: "index.d.ts", main: "index.js" }, null, 2) + "\n",
);
await writeFile(
  path.join(dir, "index.d.ts"),
  [
    "export interface FixtureDep {",
    "  /** Write a count of records. */",
    "  write(count: number): void;",
    "  read(): number;",
    "}",
    "",
    "/** Create the fixture dependency. */",
    "export declare function createFixtureDep(): FixtureDep;",
    "",
  ].join("\n"),
);
await writeFile(path.join(dir, "index.js"), "module.exports = {};\n");
console.log(`fixture-lib created at ${dir}`);
