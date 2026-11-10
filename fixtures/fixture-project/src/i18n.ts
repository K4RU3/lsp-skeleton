/**
 * 日本語コメントと絵文字を含むファイル。
 * LSP の位置は UTF-16、内部表現はバイトなので、変換がずれるとここで露呈する。
 */
export const GREETING = "こんにちは 🌏 世界";

/** 名前をあいさつに変換する。 */
export function greet(name: string): string {
  const prefix = "やあ、";
  const suffix = "さん 👋";
  return prefix + name + suffix + GREETING;
}

export class Localizer {
  private readonly labels = new Map<string, string>([["ok", "はい ✅"]]);

  /** ラベルを引く（無ければキーをそのまま返す）。 */
  label(key: string): string {
    return this.labels.get(key) ?? key;
  }
}
