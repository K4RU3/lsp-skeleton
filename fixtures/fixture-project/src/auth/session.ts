import { formatBytes, NotifierImpl } from "@lib/index";
import { parseInput } from "../lib/barrel";
import type { Notifier } from "@lib/impl";

export class SessionStore {
  private readonly notifier: Notifier;
  private lastSize = 0;

  constructor(notifier: Notifier) {
    this.notifier = notifier;
  }

  /** Refresh the session for a token and return the new size. */
  refresh(token: string): number {
    const parsed = parseInput(token);
    const numeric = parseInput(parsed.length);
    const size = formatBytes(numeric);
    this.notifier.notify(`refresh ${size}`);
    this.lastSize = numeric;
    return numeric;
  }

  get size(): number {
    return this.lastSize;
  }

  set size(value: number) {
    this.lastSize = value;
  }
}

export function makeDefaultStore(): SessionStore {
  return new SessionStore(new NotifierImpl());
}
