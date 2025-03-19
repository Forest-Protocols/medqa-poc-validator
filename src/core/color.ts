import * as ansis from "ansis";

export function colorNumber(num: bigint | number | string) {
  return ansis.bold.red(`#${num}`);
}

export function colorHex(hex: string) {
  return ansis.bold.yellow(`${hex}`);
}

export function colorKeyword(word: string) {
  return ansis.bold.cyan(word);
}
