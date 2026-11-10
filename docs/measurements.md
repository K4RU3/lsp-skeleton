# 実測値 (§8)

計測スクリプト: `node --experimental-strip-types scripts/probe-servers.ts`

環境: Node.js v24.22.1 / Linux / fixture-project (15 ファイル程度の小規模プロジェクト)

## 計測結果（M1 時点）

| 項目 | typescript-language-server 6.0.3 | vtsls 0.3.0 |
|---|---|---|
| initialize 往復 | 81 ms | 85 ms |
| プロジェクト読み込み（didOpen → progress end） | 948 ms | 1036 ms |
| callHierarchy 能力 | あり | あり |
| `outgoingCalls` の実挙動 | 解決済みの呼び出しのみ返す（未解決は返らない） | 同左 |
| documentSymbol の粒度 | クラス→メソッド→ローカル変数まで階層化 | 同左 |
| `documentSymbol` の総数 (session.ts) | 11 | 11 |
| hover 往復 | 19 ms | 14 ms |
| definition 往復 | 3 ms | 3 ms |

（数値は `npm run probe` で再計測できる。マシン負荷で ±50% 程度変動する。）

## 既定サーバの決定

**typescript-language-server を既定**とする。理由:

1. 両者とも callHierarchy を実装し、fixture 上の挙動（outgoing/incoming の内容、
   ネストしたクロージャの扱い）が**同一**だった。
2. 起動・読み込みがわずかに速い（948ms vs 1036ms）。
3. vtsls は起動に `--stdio` の明示が必要で、引数なしでは即座に落ちる
   （実測で確認済み）。既定として使うには余分な前提が増える。

差が観測できなかったため、**既定を切り替える根拠は無い**。サーバは
`serverSpec()` / `--server` で差し替え可能にしてあり、将来 vtsls 固有の優位
（大規模 monorepo での挙動など）が観測されたら既定だけ変えればよい。
