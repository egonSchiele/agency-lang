import * as path from "node:path";

export const AUDIO_FORMATS = ["wav", "mp3", "m4a"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export function isAudioFormat(name: string): name is AudioFormat {
  return (AUDIO_FORMATS as readonly string[]).includes(name);
}

/** The format `speak` writes: the explicit `format` when given, otherwise
 *  the output file's extension, otherwise wav. Returns whatever it found,
 *  so the caller can name an unknown format in its error. */
export function resolveFormat(format: string, outputFile: string): string {
  if (format !== "") {
    return format;
  }
  const extension = path.extname(outputFile).toLowerCase().replace(/^\./, "");
  if (extension === "") {
    return "wav";
  }
  return extension;
}
