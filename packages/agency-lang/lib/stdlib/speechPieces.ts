/** Breaking text into pieces for a local speech server, so a cancelled call
 *  never holds the server for more than one piece. Copied from the Kokoro
 *  package's textChunks.ts, which has the same need. */

const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });

/** `text` in pieces of at most `maxChars`. Pieces break between sentences.
 *  A sentence longer than `maxChars` is split with `splitToFit`. */
export function sentencePieces(text: string, maxChars: number): string[] {
  const sentences = [...SENTENCES.segment(text)].flatMap((sentence) =>
    splitToFit(sentence.segment, maxChars),
  );
  return packUnits(sentences, maxChars);
}

/** A sentence split into pieces of at most `maxChars`. It splits at commas
 *  first, then at spaces, then inside any word longer than `maxChars`.
 *  Every character except whitespace is kept, in order. */
export function splitToFit(sentence: string, maxChars: number): string[] {
  const units = sentence
    .trim()
    .split(/(?<=,)\s+/)
    .flatMap((clause) => (clause.length <= maxChars ? [clause] : clause.split(/\s+/)))
    .flatMap((unit) => cutWord(unit, maxChars));
  return packUnits(units, maxChars);
}

function cutWord(word: string, maxChars: number): string[] {
  const count = Math.ceil(word.length / maxChars);
  return Array.from({ length: count }, (_, index) =>
    word.slice(index * maxChars, (index + 1) * maxChars),
  );
}

function packUnits(units: string[], maxChars: number): string[] {
  const pieces: string[] = [];
  for (const unit of units) {
    if (unit === "") {
      continue;
    }
    const last = pieces.length - 1;
    if (last >= 0 && pieces[last].length + 1 + unit.length <= maxChars) {
      pieces[last] = `${pieces[last]} ${unit}`;
    } else {
      pieces.push(unit);
    }
  }
  return pieces;
}
