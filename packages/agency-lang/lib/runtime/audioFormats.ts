/** The audio output formats `std::speech.speak` supports, and their expected
 *  returned MIME types. Single source of truth — the stdlib speak helper and the
 *  DeterministicClient both import from here rather than each keeping a copy.
 *  Mirrors smoltalk's own `SPEECH_FORMAT_TO_MIME` (not publicly exported). */
export const SPEAK_FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm"] as const;
export type SpeakFormat = (typeof SPEAK_FORMATS)[number];

export const SPEECH_FORMAT_TO_MIME: Record<SpeakFormat, string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "application/octet-stream",
};

export function isSpeakFormat(value: string): value is SpeakFormat {
  return (SPEAK_FORMATS as readonly string[]).includes(value);
}
