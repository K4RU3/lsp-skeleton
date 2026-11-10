/** Parse a string input. */
export function parse(input: string): string;
/** Parse a numeric input. */
export function parse(input: number): number;
export function parse(input: string | number): string | number {
  const materialized = typeof input === "string" ? input.trim() : input.toFixed(2);
  return materialized;
}

/** Human readable label for a value. */
export function label(value: string | number | boolean): string {
  return String(value);
}
