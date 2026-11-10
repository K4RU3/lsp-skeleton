/** ESM TypeScript module (.mts). */
export function square(value: number): number {
  return value * value;
}

export const cube = (value: number): number => value * square(value);
