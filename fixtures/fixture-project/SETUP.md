# fixture-project

LSP の名前解決を検証するための小さな TypeScript プロジェクト。

- オーバーロード: `src/lib/overloads.ts`
- barrel / re-export 連鎖: `src/lib/index.ts` → `src/lib/barrel.ts` → `src/lib/impl.ts`
- paths エイリアス: `@lib/*`
- 別名 import: `NotifierImpl`, `parseInput`
- クラスのメソッド・getter/setter: `SessionStore`
- インターフェース経由のメソッド呼び出し: `Notifier.notify`
- node_modules の .d.ts: `fixture-lib`（`npm run fixture:setup` が生成）
- 未解決呼び出し: `missingHelper`
- 動的呼び出し: `registerHandler(() => store.refresh(...))`

`fixtures/fixture-project/node_modules/fixture-lib` は生成物なのでコミットしない。
