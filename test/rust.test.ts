import test from "node:test";
import assert from "node:assert/strict";

import { disposeFixtureWorkspace, rustWorkspace } from "./helpers.ts";

test.after(async () => {
  await disposeFixtureWorkspace();
});

test("rust-analyzer serves a Cargo crate and reports Rust declarations", async (context) => {
  const workspace = await rustWorkspace();
  if (workspace === undefined) return context.skip("rust-analyzer is not installed");

  // Cargo.toml plus a file inside the package is what makes rust-analyzer
  // build a crate graph; the entry file answers only once it has one.
  const readiness = await workspace.session.waitForProjectLoad();
  assert.equal(readiness.ready, true);

  const symbols = await workspace.session.documentSymbols("src/lib.rs");
  const names = symbols.map((symbol) => symbol.name);
  assert.ok(names.includes("Word"), "structs are declarations");
  assert.ok(names.includes("SearchMode"), "enums are declarations");
  assert.ok(names.includes("Lookup"), "traits are declarations");
  // Measured: a `use` clause is not a symbol, and neither is a local binding.
  assert.ok(!names.some((name) => name.includes("std::collections")));
});

test("rust skeleton folds bodies and keeps resolved signatures", async (context) => {
  const workspace = await rustWorkspace();
  if (workspace === undefined) return context.skip("rust-analyzer is not installed");
  const skeleton = await workspace.engine.skeleton("src/lib.rs");

  // Signatures come from documentSymbol.detail, which omits name and keyword.
  assert.match(skeleton.text, /pub fn join\(left: &str, right: &str, separator: &str\) -> String  \/\/ … 3 lines/);
  assert.match(skeleton.text, /pub fn group_by_length\(words: &\[Word\]\) -> HashMap<usize, Vec<String>>/);
  // Members of an impl block nest under it instead of appearing at top level.
  assert.match(skeleton.text, /impl std::fmt::Display for StoreError \{/);
  assert.match(skeleton.text, /  fn fmt\(&self, formatter: &mut std::fmt::Formatter<'_>\) -> std::fmt::Result/);
  // Type definitions stay whole: fields and variants survive, bodies do not.
  assert.match(skeleton.text, /pub struct Word \{\n  text: String\n  score: u32\n\}/);
  assert.match(skeleton.text, /pub enum StoreError \{\n  Empty\n  Duplicate\(String\)\n\}/);
  assert.match(skeleton.text, /pub union Bits \{/);
  assert.match(skeleton.text, /pub trait Lookup \{/);
  assert.match(skeleton.text, /pub type LookupResult = Result<Word, StoreError>/);
  assert.match(skeleton.text, /macro_rules! assert_word/);

  // Bodies are gone.
  assert.doesNotMatch(skeleton.text, /format!\(\{left\}/);
  assert.doesNotMatch(skeleton.text, /grouped\.entry/);
  // A local `let` is a statement, not a declaration: it never reaches the tree.
  assert.doesNotMatch(skeleton.text, /let doubled/);
});

test("rust skeleton keeps use clauses whole instead of fragmenting them", async (context) => {
  const workspace = await rustWorkspace();
  if (workspace === undefined) return context.skip("rust-analyzer is not installed");
  const skeleton = await workspace.engine.skeleton("src/store.rs");
  // `use crate::{Lookup, ...};` braces span lines in the source and must come
  // out as one clause, not as one line per path segment.
  assert.match(skeleton.text, /use crate::\{Lookup, SearchMode, StoreError, Word, MAX_WORD_LEN\};/);
  const useLines = skeleton.text.split("\n").filter((line) => line.startsWith("use "));
  assert.equal(useLines.length, 3);
});

test("rust skeleton renders const, static and type alias separately", async (context) => {
  const workspace = await rustWorkspace();
  if (workspace === undefined) return context.skip("rust-analyzer is not installed");
  const skeleton = await workspace.engine.skeleton("src/lib.rs");
  // Measured: rust-analyzer reports const and static with the same SymbolKind,
  // so the written keyword decides.
  assert.match(skeleton.text, /pub static DEFAULT_MODE: SearchMode = SearchMode::Exact/);
  assert.match(skeleton.text, /pub const MAX_WORD_LEN: usize = 64/);
  const kinds = new Map(skeleton.symbols.map((symbol) => [symbol.name, symbol.kind]));
  assert.equal(kinds.get("DEFAULT_MODE"), "static");
  assert.equal(kinds.get("MAX_WORD_LEN"), "const");
});

test("rust skeleton keeps multi-byte text intact", async (context) => {
  const workspace = await rustWorkspace();
  if (workspace === undefined) return context.skip("rust-analyzer is not installed");
  const skeleton = await workspace.engine.skeleton("src/main.rs");
  // The doc comment above data_path is Japanese: slicing with byte offsets
  // instead of UTF-16 indices drops its leading characters.
  assert.match(skeleton.text, /\/\*\* Path of the data file\. \*\//);
  assert.match(skeleton.text, /const SAVE_INTERVAL_SECS: u64 = 60/);
  assert.match(skeleton.text, /async fn main\(\)/);
});