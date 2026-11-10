/**
 * Legacy JavaScript module: no type annotations, types come from JSDoc.
 * The skeleton must still show checker-inferred signatures.
 */

/**
 * @param {string} name
 * @returns {string}
 */
export function greetLegacy(name) {
  return "hello " + name;
}

/**
 * @param {number} count
 */
export function repeatLegacy(count) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    out.push(greetLegacy(String(index)));
  }
  return out;
}

export const VERSION = "1.0.0";
