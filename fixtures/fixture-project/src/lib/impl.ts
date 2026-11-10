/** Something that can notify a human. */
export interface Notifier {
  notify(message: string): void;
}

export class ConsoleNotifier implements Notifier {
  private delivered = 0;

  /** Notify through the console. */
  notify(message: string): void {
    console.log(message);
    this.delivered += 1;
  }

  get count(): number {
    return this.delivered;
  }

  set count(value: number) {
    this.delivered = value;
  }
}

/** Format a byte count for humans. */
export const formatBytes = (bytes: number): string => `${bytes} B`;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export enum Level {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
}

export function wrap<T>(value: T): Result<T> {
  return { ok: true, value };
}
