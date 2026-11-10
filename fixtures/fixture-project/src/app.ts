import { SessionStore } from "./auth/session";
import { formatBytes, wrap } from "./lib";
import { createFixtureDep, type FixtureDep } from "fixture-lib";

const store = new SessionStore(new (requireNotifier().constructor)());

export function main(tokens: string[]): number {
  const dep = createFixtureDep();
  dep.write(tokens.length);
  let total = 0;
  for (const token of tokens) {
    total += store.refresh(token);
    formatBytes(total);
  }
  registerHandler(() => {
    store.refresh("dynamic");
  });
  missingHelper(total);
  return total;
}

export function registerHandler(handler: () => void): void {
  handlers.push(handler);
}

const handlers: Array<() => void> = [];

function requireNotifier(): never {
  throw new Error("not used");
}
