# 設計

## 層と境界

```
アダプタ (CLI / MCP / DSH plugin)
    │  ツール名・引数・表示形式だけを持つ
    ▼
問い合わせ層  src/core/*        listSymbols / skeleton / deps / expand / usages / callees / search
    │  LSP のメソッド名・JSON-RPC・位置(行/列)を知らない
    ▼
セッション層  src/lsp/*         initialize / 能力交渉 / 文書同期 / 位置変換 / プロセス管理
    │  stdio (将来: socket / 常駐)
    ▼
言語サーバ (typescript-language-server / vtsls)
```

- **1 セッション = 1 ワークスペース**。セッションは使い捨てでき、永続データを持たない。
- 結果キャッシュ（将来のファイルキャッシュ）はセッションの外に置く。本実装では
  セッション内のメモ化（`QueryContext` の tree キャッシュ）に留め、ディスクには書かない。
- 位置は常にバイトオフセットで公開する。UTF-16 ⇄ バイト変換は `src/lsp/documents.ts` のみ。

## なぜ documentSymbol を土台にするか

skeleton / deps / expand / usages はすべて「どの宣言か」を同じように決める必要がある。
`documentSymbol` はチェッカが認識した宣言を範囲付きで返すので、これを唯一の
アイデンティティ源にする:

1. `documentSymbol` で宣言と範囲を得る（overload は個別のエントリとして返る）
2. 名前位置（`selectionRange`）で `hover` を引き、**チェッカが解決した署名**を得る
3. 本文範囲は構文（TypeScript パーサ）で特定し、行数を数える
4. id は `相対パス#修飾名@署名ハッシュ6桁`

hover は表示用テキストなので、その解釈（`function` や `(+1 overload)` の除去）は
問い合わせ層の内側 (`src/core/hover-text.ts`) で閉じる。

### 署名の source of truth

通常は hover。ただし次の 2 種類は LSP が忠実な署名を返さないため、**ソースの宣言ヘッダ**
を使い、`signatureSource: "source"` として区別する（フォールバックの隠蔽ではなく明示）:

- **setter**: hover はプロパティ型（`SessionStore.size: number`）を返し、引数が消える
- **overload 実装**: hover は先頭 overload を `(+N overloads)` 付きで繰り返すだけで、
  実装自身の注釈付き署名を返さない

## deps の解決

`callHierarchy/outgoingCalls` があればそれを使う。無ければ
「本体内の直接呼び出し箇所（構文）→ `definition` → 定義位置で hover」に切り替える。
切り替えは `src/core/dependency-resolution.ts` の内側で完結し、API は変わらない。

- **オーバーロード選択**: 定義側の hover は先頭 overload しか示さないので、
  呼び出し箇所ごとに `signatureHelp` を引いて active な署名を採用する
  （引数リストの内側 = 開き括弧の直後で問い合わせる）。
- **ネストしたクロージャ**: TS の call hierarchy はコールバック内の呼び出しも
  外側の宣言に紐づける。構文側で「直接の呼び出し」を列挙し、そこに無いサイトは
  クロージャ帰属として落とし、落とした件数を注記する。
- **未解決**: call hierarchy に出ない直接呼び出しは `unresolved` として必ず表に出す。
  `missingHelper(total)` のような未定義呼び出しがこれに当たる。
- **標準ライブラリ**: `lib.es5.d.ts` 等への呼び出しは deps の対象外として件数だけ注記する。

## 能力交渉

`initialize` の結果から `documentSymbolProvider` / `hoverProvider` /
`definitionProvider` / `callHierarchyProvider` / `signatureHelpProvider` を読み、
無い機能は代替経路に落ちる。サーバ固有拡張は一切使わない。

## 読み込み待ち

`$/progress` の begin/end を監視し、プロジェクト読み込みの完了を待つ。
サーバが進捗を出さない場合は「観測できなかった」ことを `ReadinessReport.signal` で返し、
空の結果を「正」として返さない（`notes` に readiness 注記が付く）。
