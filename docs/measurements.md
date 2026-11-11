# 実測値 (§8)

計測スクリプト: `npm run probe` (= `scripts/probe-servers.ts`)

環境: Node.js v24.22.1 / Linux / fixture-project（15 ファイル程度の小規模プロジェクト）

## 計測結果

3 回計測した範囲（同一マシン・同一フィクスチャ、負荷により変動）:

| 項目 | typescript-language-server 6.0.3 | vtsls 0.3.0 |
|---|---|---|
| initialize 往復 | 78 – 81 ms | 85 – 87 ms |
| プロジェクト読み込み（didOpen → progress end） | 948 – 1300 ms | 1036 – 1442 ms |
| callHierarchy 能力 | あり | あり |
| `outgoingCalls` の結果（SessionStore.refresh） | 3 件 | 3 件（同一） |
| `incomingCalls` の結果 | 1 件 | 1 件（同一） |
| documentSymbol の総数 (session.ts) | 11 | 11（同一構造） |
| documentSymbol の粒度 | クラス→メソッド→ローカル変数まで階層化 | 同左 |
| hover 往復 | 13 – 22 ms | 14 – 22 ms |
| definition 往復 | 3 – 10 ms | 3 ms |

参考: 実プロジェクト（このリポジトリ自身、src 15 ファイル + node_modules の型）でも
initialize は 100ms 未満、読み込みは 1.5 秒前後で、体感は「コマンド起動ごとに約 2 秒」。
MCP / DSH アダプタはワークスペースごとにセッションを再利用するため、
2 回目以降のツール呼び出しは読み込み待ち無しで返る（実測: skeleton 1 回目 4.2 秒、
2 回目以降 0.05 秒未満）。

## 既定サーバの決定

**typescript-language-server を既定**とする。根拠:

1. 両者とも callHierarchy を実装し、fixture 上の outgoing/incoming の内容が**完全に一致**した
   （ネストしたクロージャの扱いまで同じ）。差が出ない以上、乗り換える根拠が無い。
2. initialize とプロジェクト読み込みが一貫してわずかに速い（948–1300ms vs 1036–1442ms）。
3. vtsls は起動に `--stdio` の明示が必要で、引数なしでは即座に異常終了する
   （実測で確認）。既定として使うには余分な前提が増える。

サーバは `serverSpec()` / `--server` / MCP の `--server` / DSH の `config.server` で
差し替えられる。将来 vtsls 固有の優位（大規模 monorepo での挙動など）が観測されたら、
既定だけ変えればよい。

## サーバ差異として観測したもの（既定選定には影響しないが記録）

- **callHierarchy は解決済みの呼び出ししか返さない**（両者共通）。未解決呼び出しは
  構文側の直接呼び出し列挙との差分で拾う必要がある（実装済み）。
- **overload 実装の hover は先頭 overload を繰り返す**（両者共通）。実装自身の
  シグネチャはソースヘッダから取る（`signatureSource: "source"`）。
- **setter の hover は引数を落とす**（両者共通）。
- **workspace/symbol はプロジェクト未オープンで "No Project" エラー**（tsserver 側の制約）。
  `ensureProjectOpen()` で tsconfig 先頭ファイルを開いてから問い合わせる。
## Rust（rust-analyzer）の実測

計測スクリプト: `.probe/` 配下（gitignore 済み）。フィクスチャは `fixtures/rust-project`
（自前クレート）と、実プロジェクト `~/dev/Shiritori`（`shiritori_v4`、15 ファイル / 約 6488 行）。

**バイナリの所在**: `rust-analyzer` は PATH に無い。実測に使ったのは
`~/.vscode/extensions/rust-lang.rust-analyzer-0.3.3105-linux-x64/server/rust-analyzer`
（`0.3.3105-standalone`）。`~/.local/share/nvim/mason/packages/rust-analyzer/` の
`0.3.2660-standalone` でも同じ答えを返すことを確認済み。
`~/.cargo/bin/rust-analyzer` は rustup のプロキシで、`Unknown binary 'rust-analyzer' in official toolchain`
を出して起動しない。そのため `LSP_SKELETON_RUST_ANALYZER` で実体を指せるようにした。

### 時間

| 項目 | fixtures/rust-project | Shiritori |
|---|---|---|
| initialize 往復 | 5 – 8 ms | 6 ms |
| プロジェクト読み込み完了（progress 静止まで） | 1761 – 1891 ms | 357 – 476 ms |
| skeleton 1 回目（暖まった後） | 13 – 25 ms | 2 – 7 ms |
| skeleton 2 回目以降（キャッシュ） | 0 – 1 ms | 0 ms |
| 全 15 ファイルの skeleton 合計（Shiritori） | — | 3.6 秒（初回、クレート読み込み込み） |

### 宣言の返り方（§6 の実測項目）

- **`use` はシンボルとして返らない**。トップレベルの `use` はどれも documentSymbol に現れず、
  「シンボルが覆っていない領域」としてのグローバル描画だけが拾う。
- **ローカルの `let` も返らない**。Shiritori 全ファイルで SymbolKind 13（Variable）は 0 件。
  つまり TypeScript と違い、木から落とすための特別扱いは要らない（プロファイルは
  `keepsLocals: false` を宣言し、他のサーバが返した場合の保険だけを持つ）。
- **`impl` ブロックは kind 23（Struct）または 19（Object）で、名前が `impl <ヘッダ>`**。
  どちらの kind で来るかはブロックによるため、判別は名前の `impl ` 接頭辞だけで行う。
- **`documentSymbol.detail` が解決済みシグネチャ**。`fn(&self, text: &str) -> Option<Word>`、
  `u64`、`Result<T, MessengerError>`。**名前・`pub`・`async`・const の値は入らない**ため、
  それらはソースのヘッダから補う。enum のヴァリアントと `macro_rules!` は detail が空。
- **`selectionRange` は全 kind で名前そのもの**。hover / prepareCallHierarchy に渡す位置として
  そのまま使える。一方 **`range.start` は属性より前の空行を指すことがある**（実測: オフセット 170 は
  空行、属性は 197 から）。宣言の開始位置には使えるが、名前の解決には使えない。
- **hover の形式**: 省略可能なクレートフェンス → 宣言フェンス → `---` 区切りのセクション
  （`size = ...`、`Is dyn-compatible`、ドキュメントコメント）。
- **enum ヴァリアントの hover は空**。シグネチャはソースの本文（`Fuzzy { max_distance: u8 }`）から取る。
- **`languageId` の値は答えに影響しない**: `"rust"` でも `"typescript"` でも同じ結果を返す（実測）。

### 読み込み待ち

progress トークンは `Fetching` / `Building CrateGraph` / `Roots Scanned` /
`Building compile-time-deps` / `Loading proc-macros` / `Indexing` / `cargo check`。
**最初の `Fetching` は約 220 ms で終わるが、その時点ではクレートグラフがまだ無く、
documentSymbol は空配列を返す**。空を「宣言が無い」と解釈すると skeleton が空になるため、
プロファイルが入口ファイルを 50 ms 間隔でポーリングし、非空が返るまで待つ（実測:
Shiritori で 110 – 500 ms、フィクスチャで最大 1.9 秒）。

### hover のコスト（重要）

`0.3.3105` では **const / static の hover が 1 件あたり約 6.5 秒**かかる（同一位置で 3 回計測し、
6846 / 6524 / 6588 ms）。型・関数・構造体の hover は 0 – 4 ms なので、原因は特定の宣言種別に
限られる（enum 値を持つ const / static、`&str` の const で再現。`1 + 2` の const は 1 ms）。
`0.3.2660` では同じ位置が 2 – 73 ms なので、新しいビルド側の退行である。

Rust は署名を detail から、ドキュメントをソースの `///` から取れるため、**hover を引かない**
（`LanguageProfile.wantsHover: false`）。この判断が無い場合、フィクスチャの skeleton 1 回が
6.8 秒かかっていた（実測）。TypeScript は逆に hover が唯一の推論型の源なので `true`。

### その他の観測

- `callHierarchy` は実装されている。`prepareCallHierarchy` は関数名で成功し、
  構造体では `[]` を返す。Shiritori の `main` に対する `outgoingCalls` は 34 件
  （std / core / cargo レジストリ内の項目を含む）、`load_file` の `incomingCalls` は 11 件。
- `cargo check` は `target/debug/.cargo-lock` に書けず失敗するが（読み取り専用領域）、
  documentSymbol / hover / callHierarchy の答えには影響しない。
- ファイルを開いた直後の `documentSymbol` は、クレートグラフ構築前だと `[]`（上記）。
