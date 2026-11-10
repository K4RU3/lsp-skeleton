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
