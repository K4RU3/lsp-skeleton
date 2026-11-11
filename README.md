# lsp-skeleton

TypeScript/JavaScript と Rust のコードベースを少ないコンテキストで把握するための、
LSP（tsserver / rust-analyzer の名前解決）を土台にした **skeleton / deps / expand** ツール。

- **共通部** (`src/lsp`, `src/core`, `src/syntax`): LSP セッションと意味単位の問い合わせ API。LSP のメソッド名・JSON-RPC・行/列位置を外へ漏らさない。
- **MCP アダプタ** (`src/adapters/mcp`): 共通部を MCP ツールとして公開する薄い層。
- **DeepSeek Harness プラグイン** (`src/adapters/dsh`): ハーネスの `ctx.tools` に登録する薄い層。
- **CLI** (`src/cli.ts`): 手元確認用。

## なぜ LSP か

tree-sitter は構文しか持たない。import の追跡、re-export / barrel の連鎖、
tsconfig の `paths` エイリアス、オーバーロード選択、メソッドの受け手の型、
`.d.ts` の解決は、すべて型チェッカの仕事である。LSP 越しに tsserver を借りることで、
これらを自前実装せずに済ませる（自前の簡易パースは取りこぼしが静かに起きるため採らない）。

## 設計

```
アダプタ (CLI / MCP / DSH plugin)     ツール名・引数・表示だけを知る
        │  共通部 API: skeleton / deps / expand / usages / callees / search
        ▼
問い合わせ層  src/core/*              意味単位。LSP を知らない
        │
セッション層  src/lsp/*               initialize / 能力交渉 / 文書同期 / 位置変換 / プロセス管理
        │  stdio（将来: socket / 常駐化はこの層の内側だけで差し替え）
        ▼
言語サーバ (typescript-language-server / vtsls / rust-analyzer)
```

言語差は `src/languages/*` の**言語プロファイル**に閉じる。セッション層・トランスポート・
結果キャッシュ・アダプタ層は言語を知らず、問い合わせ層は「いま何語か」を尋ねない。

1 セッション = 1 ワークスペース。セッションは使い捨て可能で、永続データを持たない。
結果キャッシュ（skeleton の永続化）はセッションの外に置き、ファイル内容ハッシュを
キーにする。詳細は [docs/design.md](docs/design.md)。

## 3 つの機能

```ts
import { createWorkspace } from "lsp-skeleton";

const workspace = await createWorkspace({ root: "/path/to/project" });
try {
  // 1. skeleton: 構造と型だけ。本体は行数に畳む
  const skeleton = await workspace.engine.skeleton("src/auth/session.ts");
  // 2. deps: 依存表＋未解決一覧（インライン展開しない）
  const deps = await workspace.engine.deps("src/auth/session.ts", "SessionStore.refresh");
  // 3. expand: 指定した関数の本体だけ
  const body = await workspace.engine.expand("src/auth/session.ts", "SessionStore.refresh");
} finally {
  workspace.dispose();
}
```

### skeleton

```ts
// src/auth/session.ts · export 2
import { formatBytes, NotifierImpl } from "@lib/index";

export function makeDefaultStore(): SessionStore  // … 3 lines
export class SessionStore {
  constructor(notifier: Notifier)  // … 3 lines
  lastSize: number
  /** Refresh the session for a token and return the new size. */
  refresh(token: string): number  // … 8 lines
  get size(): number  // … 3 lines
  set size(value: number)  // … 3 lines
}

// exports: makeDefaultStore, SessionStore
```

シグネチャはチェッカが解決したもの（推論された戻り値型を含む）。構文だけの切り出しには
フォールバックしない。ただし LSP が忠実な署名を返さない 2 種類（setter、overload 実装）だけは
ソースの宣言ヘッダを使い、`signatureSource: "source"` として区別する。

### deps

```
src/app.ts#main@d709ce
  [ext] node_modules/fixture-lib/index.d.ts#createFixtureDep@7c7a4d  function createFixtureDep(): FixtureDep
  [in]  src/auth/session.ts#SessionStore.refresh@9d722e  SessionStore.refresh(token: string): number
unresolved:
  missingHelper (line 18, no-definition)
note (dynamic-dispatch): ... 動的呼び出しは拾えない ...
```

- オーバーロードは**呼び出し箇所ごとに** `signatureHelp` で選択された署名を使う。
- barrel / 別名 import / `paths` エイリアス / `.d.ts` はチェッカに解決させる。
- 解決できなかった呼び出しは必ず `unresolved` に出す（黙って落とさない）。
- 標準ライブラリ（`lib.*.d.ts`）は deps の対象外として件数だけ注記する。
- クロージャ内の呼び出しは外側の関数に帰属させず、落とした件数を注記する。

### expand

`documentSymbol` の range（宣言全体）で元テキストを切り出す。専用リクエストは使わない。

## 使い方

### CLI

```sh
node --experimental-strip-types src/cli.ts --root fixtures/fixture-project skeleton src/auth/session.ts
node --experimental-strip-types src/cli.ts --root fixtures/fixture-project deps src/app.ts main
node --experimental-strip-types src/cli.ts --root fixtures/fixture-project expand src/app.ts main
node --experimental-strip-types src/cli.ts --root fixtures/fixture-project --cache .cache skeleton src/app.ts
node --experimental-strip-types src/cli.ts --root fixtures/rust-project --server rust-analyzer skeleton src/lib.rs
```

`--server` は `typescript-language-server` / `vtsls` / `rust-analyzer`。
`rust-analyzer` は PATH 上の実行ファイルを使う（`LSP_SKELETON_RUST_ANALYZER` で差し替え可能）。

### MCP

```sh
node --experimental-strip-types src/adapters/mcp/server.ts --root /path/to/project
# あるいは build 後: lsp-skeleton-mcp --root /path/to/project
```

公開ツール: `skeleton` / `expand` / `deps` / `usages` / `callees` / `search`。
すべての結果に `note (...)` 行（未解決・動的呼び出し・標準ライブラリ・readiness）が付く。

### DeepSeek Harness プラグイン

```sh
dsh plugin --profile web add /path/to/lsp-skeleton
```

`cordis.patch.yml` が bundle として `lsp-skeleton` を挿入し、`lsp_skeleton` /
`lsp_expand` / `lsp_deps` / `lsp_usages` / `lsp_callees` / `lsp_search` を登録する。
ワークスペースはセッションの working directory から取る。
共通部はハーネスのプラグイン形式に依存しない（`src/index.ts` はハーネスを import しない）。

## 開発

```sh
npm install
npm run build
npm test          # フィクスチャに対する受け入れテスト（61 件。rust-analyzer が無い環境では Rust 分を skip）
npm run probe     # §8 の実測（両サーバの capacity / 起動時間）
```

`fixtures/fixture-project` は検証用プロジェクト。`.d.ts` 依存は
`npm run fixture:setup` が生成する（テストは自動で生成する）。
`fixtures/rust-project` は Rust 用の自前クレート（struct / enum / union / trait / impl /
type alias / const / static / macro_rules / mod を 1 つずつ含む）。

### Rust 対応の現状

R1（登録 + skeleton）と R2（expand）完了。`deps` / `usages` / `callees` の Rust 対応は
R3 で入る。現時点で Rust ファイルに対してそれらを呼ぶと、プロファイルが
`resolution` を持つため解決自体は走るが、検証済みなのは skeleton と expand までである。

## 限界（出力にも明示される）

- 動的呼び出し（コールバック登録、イベントハンドラ、DI、文字列による登録）は静的解析では拾えない。
- usages が 0 件でも「呼ばれていない」証明にはならない。
- deps は「解決できた依存」の一覧であり、完全性の証明ではない。
- 言語サーバの読み込みが終わっていない可能性は `note (readiness)` で示す。

## ドキュメント

- [docs/design.md](docs/design.md) — 層と境界、documentSymbol を土台にする理由、能力交渉、キャッシュの限界
- [docs/measurements.md](docs/measurements.md) — §8 の実測と既定サーバの決定根拠
- [docs/report.md](docs/report.md) — マイルストーンごとの完了報告（変更ファイル・コミット・実測・残課題）
