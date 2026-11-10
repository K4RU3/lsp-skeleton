import test from "node:test";
import assert from "node:assert/strict";

import { SourceText } from "../src/core/source-text.ts";
import { disposeFixtureWorkspace, fixtureWorkspace } from "./helpers.ts";

test.after(async () => {
  await disposeFixtureWorkspace();
});

test("SourceText maps every character boundary in both directions", () => {
  const text = "aあ🌏b\n二行目\r\n三行目";
  const source = new SourceText(text);
  assert.equal(source.byteLength, Buffer.byteLength(text, "utf8"));
  // Round-trips are exact at character boundaries (a lone surrogate half has
  // no byte offset of its own and snaps to the start of its pair).
  for (let utf16 = 0; utf16 <= text.length; ) {
    assert.equal(source.toUtf16(source.toByte(utf16)), utf16, `utf16 ${utf16}`);
    utf16 += (text.codePointAt(utf16) ?? 0) > 0xffff ? 2 : 1;
  }
  for (let byte = 0; byte <= source.byteLength; byte += 1) {
    // A byte offset inside a character snaps to that character's start.
    const snapped = source.toByte(source.toUtf16(byte));
    assert.ok(snapped <= byte, `byte ${byte} snaps backwards`);
    assert.equal(source.toUtf16(snapped), source.toUtf16(byte));
  }
  assert.equal(source.slice(source.toByte(1), source.toByte(4)), "あ🌏");
  assert.equal(source.lineAt(0), 1);
  assert.equal(source.lineAt(source.toByte(6)), 2);
});

test("positions survive multi-byte text (UTF-16 vs bytes)", async () => {
  const { engine, session } = await fixtureWorkspace();
  const document = await session.openDocument("src/i18n.ts");
  const text = document.source.text;
  assert.ok(Buffer.byteLength(text, "utf8") > text.length, "fixture must contain multi-byte text");

  // Every character boundary survives the byte -> LSP position -> byte trip.
  for (let offset = 0; offset < text.length; ) {
    const byte = document.source.toByte(offset);
    assert.equal(document.source.byteAt(document.source.positionAt(byte)), byte, `utf16 ${offset}`);
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  }

  const skeleton = await engine.skeleton("src/i18n.ts");
  assert.match(skeleton.text, /export function greet\(name: string\): string/);
  assert.match(skeleton.text, /label\(key: string\): string/);

  const greet = skeleton.symbols.find((symbol) => symbol.name === "greet");
  assert.ok(greet);
  assert.match(greet.doc ?? "", /あいさつ/);

  const expanded = await engine.expand("src/i18n.ts", "greet");
  assert.match(expanded.text, /const prefix = "やあ、";/);
  assert.match(expanded.text, /さん 👋/);
  assert.ok(expanded.text.endsWith("}\n"));
});

test("deps of a multi-byte file stays consistent", async () => {
  const { engine } = await fixtureWorkspace();
  const deps = await engine.deps("src/i18n.ts", "greet");
  assert.equal(deps.entries.length, 0);
  assert.equal(deps.unresolved.length, 0, "only string concatenation happens here");
  assert.ok(deps.notes.some((note) => note.kind === "dynamic-dispatch"));
});
