/** Kokoro reads at most 510 phoneme tokens and silently drops the rest.
 *  English text reaches that limit at about 400 characters. 250 leaves room
 *  for text that phonemizes long, such as numbers and abbreviations. */
export const MAX_CHUNK_CHARS = 250;

/** The most text one kokoro-js `TextSplitterStream` is given. Its work
 *  grows with the square of the text it holds, so long text goes to it in
 *  windows. */
export const MAX_WINDOW_CHARS = 1000;

const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });

/** `text` in windows of at most `maxChars`. Windows break between
 *  sentences. A sentence longer than `maxChars` is split with `splitToFit`. */
export function sentenceWindows(text: string, maxChars: number = MAX_WINDOW_CHARS): string[] {
  const sentences = [...SENTENCES.segment(text)].flatMap((sentence) =>
    splitToFit(sentence.segment, maxChars),
  );
  return packUnits(sentences, maxChars);
}

/** A sentence split into pieces of at most `maxChars`. It splits at commas
 *  first, then at spaces, then inside any word longer than `maxChars`.
 *  Every character except whitespace is kept, in order. */
export function splitToFit(sentence: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
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
    const last = pieces.length - 1;
    if (last >= 0 && pieces[last].length + 1 + unit.length <= maxChars) {
      pieces[last] = `${pieces[last]} ${unit}`;
    } else {
      pieces.push(unit);
    }
  }
  return pieces;
}
