/** Kokoro silently truncates input past 510 phoneme tokens, which English
 *  text reached after roughly 400 characters. 250 leaves room for text
 *  that phonemizes long, such as numbers and abbreviations. */
export const MAX_CHUNK_CHARS = 250;

/** A sentence split into pieces of at most `maxChars`, at commas first and
 *  then at spaces. Every word is kept, in order. A single word longer than
 *  `maxChars` stays whole. */
export function splitToFit(sentence: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  const units = sentence
    .split(/(?<=,)\s+/)
    .flatMap((clause) => (clause.length <= maxChars ? [clause] : clause.split(/\s+/)))
    .filter((unit) => unit !== "");
  return packUnits(units, maxChars);
}

function packUnits(units: string[], maxChars: number): string[] {
  return units.reduce<string[]>((pieces, unit) => {
    const last = pieces.at(-1);
    if (last !== undefined && last.length + 1 + unit.length <= maxChars) {
      return [...pieces.slice(0, -1), `${last} ${unit}`];
    }
    return [...pieces, unit];
  }, []);
}
