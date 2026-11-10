# 完了報告（マイルストーン別）

各節は §10 の形式（変更ファイル・コミット・確認方法・実測値・残課題）に従う。

---

## M1: 最小 LSP クライアント + skeleton

**追加・変更したファイル**

| ファイル | 役割 |
|---|---|
| `src/lsp/transport.ts` | Content-Length フレーミングの JSON-RPC over stdio。LSP のメソッド名は知らない |
| `src/lsp/protocol.ts` | クライアントが送受信する LSP 3.17 の構造的型（サブセット） |
| `src/lsp/documents.ts` | 文書ストア。`file://` URI ⇄ パス、ディスク読み込み |
| `src/lsp/session.ts` | initialize / 能力交渉 / リクエスト ID / didOpen・didChange / 進捗待ち / プロセス管理 |
| `src/lsp/server-factory.ts` | 起動スペック（typescript-language-server / vtsls）と既定の切り替え口 |
| `src/core/source-text.ts` | バイト ⇄ UTF-16 ⇄ LSP position の変換（位置の唯一の持ち主） |
| `src/syntax/ts-syntax.ts` | 構文でしか分からない情報（宣言ヘッダ・本体範囲・分類・呼び出し箇所） |
| `src/core/hover-text.ts` | hover（表示テキスト）から署名と JSDoc 要約を取り出す。この層の内側で閉じる |
| `src/core/ids.ts` | 関数 ID `path#qualifiedName@hash6` |
| `src/core/symbols.ts` | documentSymbol + hover から共通のシンボルモデルを構築（唯一のアイデンティティ源） |
| `src/core/skeleton.ts` | 本体を畳んだ skeleton の描画 |
| `src/core/context.ts` / `src/core/types.ts` | セッションスコープの文脈と、アダプタ非依存の結果型 |
| `src/index.ts` | 共通部の公開 API（`createWorkspace`） |
| `scripts/probe-servers.ts` | §8 の実測スクリプト |
| `test/skeleton.test.ts` ほか | フィクスチャに対する受け入れテスト |

**コミット**: `27a37cb` feat(m1): LSP client, session layer and skeleton output

**動作確認**

```sh
node --experimental-strip-types src/cli.ts --root fixtures/fixture-project skeleton src/auth/session.ts
```

```
// src/auth/session.ts · export 2
import { formatBytes, NotifierImpl } from "@lib/index";
...
export function makeDefaultStore(): SessionStore  // … 3 lines
export class SessionStore {
  constructor(notifier: Notifier)  // … 3 lines
  lastSize: number
  notifier: Notifier
  /** Refresh the session for a token and return the new size. */
  refresh(token: string): number  // … 8 lines
  get size(): number  // … 3 lines
  set size(value: number)  // … 3 lines
}

// exports: makeDefaultStore, SessionStore
```

受け入れ条件（§5.2）の各要素:

- 関数宣言 / const アロー / クラス / メソッド / getter・setter — 上記のとおり
- 型定義（interface / type / enum）— `src/lib/impl.ts` の skeleton で確認（テスト）
- グローバルコード（トップレベル文）— import 文と `const handlers` を保持
- export 一覧 — 末尾の `// exports:`
- JSDoc 要約行 — `/** Refresh ... */`
- 本体を畳み行数を表示 — `// … N lines`
- チェッカ解決の署名 — 推論戻り値型つき（`makeDefaultStore(): SessionStore`）

**実測**: initialize 78–81ms / プロジェクト読み込み 948–1300ms / hover 13–22ms / definition 3–4ms

**残課題**: LSP が忠実な署名を返さない 2 種類（setter、overload 実装）はソースヘッダを
使う。`signatureSource: "source"` として区別しているが、skeleton のテキストには現れない。

---

## M2: deps

**追加・変更したファイル**

| ファイル | 役割 |
|---|---|
| `src/core/dependency-resolution.ts` | outgoingCalls（無ければ definition ベース）で依存を解決。オーバーロード選択・クロージャ帰属・stdlib 判定 |
| `src/core/query.ts` | `deps` / `callees` / `usages` / `search` を公開 |
| `test/deps.test.ts` | barrel / 別名 import / メソッド / .d.ts / 未解決 / クロージャ / stdlib の検証 |

**コミット**: `8d869b1` feat(m2,m3): dependency table, unresolved reporting and expand
（M3 と同時にコミット。M2 の受け入れ条件は同コミット内の `test/deps.test.ts` が担保）

**動作確認**

```sh
node --experimental-strip-types src/cli.ts --root fixtures/fixture-project deps src/app.ts main
```

```
src/app.ts#main@d709ce
  [ext] node_modules/fixture-lib/index.d.ts#createFixtureDep@7c7a4d  function createFixtureDep(): FixtureDep
  [ext] node_modules/fixture-lib/index.d.ts#FixtureDep.write@1b60c7  FixtureDep.write(count: number): void
  [in]  src/auth/session.ts#SessionStore.refresh@9d722e  SessionStore.refresh(token: string): number
  [in]  src/lib/impl.ts#formatBytes@0200ff  const formatBytes: (bytes: number) => string
  [in]  src/app.ts#registerHandler@d254f8  function registerHandler(handler: () => void): void
unresolved:
  missingHelper (line 18, no-definition)
note (dynamic-dispatch): ...
note (dynamic-dispatch): 1 call site(s) inside nested closures were attributed to the closure, ...
note (unresolved): 1 call(s) could not be resolved and are listed under "unresolved"; ...
```

受け入れ条件:

| 条件 | 結果 |
|---|---|
| barrel 経由（`@lib/index` → `barrel` → `impl`） | `formatBytes` が `src/lib/impl.ts` に解決 |
| 別名 import（`parse as parseInput`, `ConsoleNotifier as NotifierImpl`） | `parse` に解決。署名は宣言名に正規化 |
| メソッド呼び出し（`this.notifier.notify(...)`） | `Notifier.notify` に解決、kind=method |
| .d.ts 内の依存 | `node_modules/fixture-lib/index.d.ts` を external として解決 |
| オーバーロード選択 | `parse(input: string)` と `parse(input: number)` を別 ID で返す |
| 未解決 | `missingHelper` を unresolved に列挙 |
| 動的呼び出し | クロージャ内の `store.refresh` は外側に帰属させず、件数を注記 |

**実測**: deps（暖）35–39ms / 1 関数あたりの解決は 3–5 リクエスト

**残課題**

- 戻り値型がジェネリックな呼び出しでは、signatureHelp の activeSignature が
  サーバによっては曖昧（fixture では再現せず）。
- コールバック引数として渡した関数（`registerHandler(() => ...)`）は「呼び出し」では
  ないため deps に出ない。これは仕様どおり（動的呼び出しとして注記）。

---

## M3: expand

**追加・変更したファイル**

| ファイル | 役割 |
|---|---|
| `src/core/query.ts` (`expand`) | documentSymbol の range で本体込みの宣言を切り出す |
| `src/syntax/ts-syntax.ts` (`declarationStart`) | トップレベル宣言を `export const` を含む文範囲に広げる |
| `test/expand.test.ts` | メソッド / 関数 / アロー / ID 指定の検証 |

**コミット**: `8d869b1`（M2 と同一コミット）

**動作確認**

```sh
node --experimental-strip-types src/cli.ts --root fixtures/fixture-project expand src/auth/session.ts SessionStore.refresh
```

本体（`const parsed = parseInput(token);` … `return numeric;`）がそのまま返り、
次の宣言（`makeDefaultStore`）は含まれない。`.mts` のアロー関数や、日本語・絵文字を
含むファイルでもバイト位置がずれないことを `test/positions.test.ts` で検証。

---

## M4: MCP アダプタ

**追加・変更したファイル**

| ファイル | 役割 |
|---|---|
| `src/adapters/mcp/server.ts` | MCP ツール登録（skeleton / expand / deps / usages / callees / search）と stdio 接続 |
| `src/lsp/session.ts` (`ensureProjectOpen`) | workspace/symbol の "No Project" 回避 |
| `test/mcp.test.ts` | 実 stdio トランスポート経由の E2E |

**コミット**: `f6490ce` feat(m4): MCP adapter exposing skeleton/expand/deps/usages/callees/search

**動作確認**: `test/mcp.test.ts` が `StdioClientTransport` でサーバを起動し、
`listTools` と `callTool` を実行する（5 テスト）。

**実測**: MCP ツール呼び出し 1 回目 約 4.2 秒（プロジェクト読み込み込み）、
同一ワークスペースの 2 回目以降は 0.05 秒未満（セッション再利用）。

**残課題**: 出力はテキスト（`content`）のみ。構造化出力（`structuredContent`）は
スキーマを共通部の型から生成する仕組みが要るため初版では見送った。

---

## M5: DeepSeek Harness プラグイン

**追加・変更したファイル**

| ファイル | 役割 |
|---|---|
| `src/adapters/dsh/plugin.ts` | `ctx.tools` への 6 ツール登録、`Config` スキーマ、fiber スコープのセッション後始末 |
| `cordis.patch.yml` | dsh plugin add 用の bundle patch |
| `package.json` | `./dsh` エクスポート、`dsh.bundle.patch`、optional peerDependencies |
| `test/dsh-plugin.test.ts` | 実 Cordis + 実 ToolRuntime 上での E2E |

**コミット**: `73de07e` feat(m5): DeepSeek Harness plugin adapter（初版）、
`1209742` test(dsh): run the plugin through a real Cordis context and ToolRuntime、
`8848389` feat(dsh): declare and validate the plugin's config schema

**動作確認**: 実際の `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` の
`ToolRuntime` を起動し、プラグインを fiber としてロードして
`ctx.tools.execute`（エージェントループと同じ経路）で各ツールを実行する。
`--dump-config` で実プロファイルに patch が載ることも確認。

**共通部への影響**: **無し**。ハーネス固有の要求（`defineTool` の output schema、
`ctx.workingDirectory`）はアダプタ内で吸収できた。共通部は
`@deepseek-ai/*` を一切 import しない（`src/index.ts` の依存は Node 標準と
`typescript` / LSP サーバのみ）。

**残課題**: `ctx.effect` による後始末は、ハーネスがプラグインを unload した
ときに走る。プロセスが SIGKILL された場合は言語サーバも道連れになる
（子プロセスは親の死で孤児になるが、stdio が閉じるため実質的に終了する）。

---

## 横断的な実測（§8）

`npm run probe` の結果は [measurements.md](measurements.md) にまとめた。要点:

- 両サーバとも callHierarchy を実装し、fixture 上の outgoing/incoming は**完全一致**。
- initialize・読み込みとも typescript-language-server がわずかに速い。
- したがって既定は typescript-language-server のまま（差が無い以上、乗り換える根拠が無い）。
- vtsls は `--stdio` の明示が必要（実測で確認）。

## 既知の限界

- 動的呼び出し（コールバック登録・イベントハンドラ・DI・文字列登録）は静的解析で拾えない。
  usages が 0 件のときは必ず注記が付く。
- ファイルキャッシュは「そのファイル自身の内容」だけをキーにするため、依存先の型変更では
  無効化されない（[design.md](design.md) に明記）。
- 共有層（常駐化・多重化）は未実装。セッション層のトランスポート差し替えとして
  入る設計は維持している（`StreamTransport` / `LspSession.start`）。
