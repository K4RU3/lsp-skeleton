# lsp-skeleton

TypeScript/JavaScript のコードベースを少ないコンテキストで把握するための、
LSP（tsserver の名前解決）を土台にした skeleton / deps / expand ツール。

- 共通部（`src/`）: LSP セッションと意味単位の問い合わせ API。LSP のメソッド名・JSON-RPC を外へ漏らさない。
- MCP アダプタ（`src/adapters/mcp/`）: 共通部を MCP ツールとして公開する薄い層。
- DeepSeek Harness プラグイン（`src/adapters/dsh/`）: ハーネスの `ctx.tools` に登録する薄い層。

## 設計

```
アダプタ (MCP / DSH plugin)      ツール名・引数・表示だけを知る
        ↓ 共通部 API (listSymbols / signatureAt / outgoingCalls / ...)
問い合わせ層                     意味単位。LSP を知らない
        ↓
セッション層 (LspSession)        initialize / 能力交渉 / 文書同期 / 位置変換 / プロセス管理
        ↓ stdio (将来: socket / daemon)
言語サーバ (typescript-language-server / vtsls)
```

結果キャッシュはセッションの外（ファイル）に置き、セッションは使い捨て可能に保つ。
1 セッション = 1 ワークスペース。

詳細は [docs/design.md](docs/design.md) と [docs/measurements.md](docs/measurements.md)。

## 開発

```sh
npm install
npm run build
npm test
```
