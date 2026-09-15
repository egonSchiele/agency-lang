export type Voice = {
  id: string;
  name: string;
  language: string;
  gender: string;
  grade: string;
};

export const DEFAULT_VOICE = "af_heart";

/** Copied from kokoro-js 1.2.1, which only exposes its table on a loaded
 *  model. The integration test checks the two still match.
 *
 *  `grade` is the voice's overall grade from the Kokoro model card, at
 *  https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md. It rates
 *  how clean the voice's training audio was and how much of it the model
 *  heard. An A voice sounds the most natural. An F voice sounds the least. */
export const VOICES: Voice[] = [
  { id: "af_heart", name: "Heart", language: "en-us", gender: "Female", grade: "A" },
  { id: "af_alloy", name: "Alloy", language: "en-us", gender: "Female", grade: "C" },
  { id: "af_aoede", name: "Aoede", language: "en-us", gender: "Female", grade: "C+" },
  { id: "af_bella", name: "Bella", language: "en-us", gender: "Female", grade: "A-" },
  { id: "af_jessica", name: "Jessica", language: "en-us", gender: "Female", grade: "D" },
  { id: "af_kore", name: "Kore", language: "en-us", gender: "Female", grade: "C+" },
  { id: "af_nicole", name: "Nicole", language: "en-us", gender: "Female", grade: "B-" },
  { id: "af_nova", name: "Nova", language: "en-us", gender: "Female", grade: "C" },
  { id: "af_river", name: "River", language: "en-us", gender: "Female", grade: "D" },
  { id: "af_sarah", name: "Sarah", language: "en-us", gender: "Female", grade: "C+" },
  { id: "af_sky", name: "Sky", language: "en-us", gender: "Female", grade: "C-" },
  { id: "am_adam", name: "Adam", language: "en-us", gender: "Male", grade: "F+" },
  { id: "am_echo", name: "Echo", language: "en-us", gender: "Male", grade: "D" },
  { id: "am_eric", name: "Eric", language: "en-us", gender: "Male", grade: "D" },
  { id: "am_fenrir", name: "Fenrir", language: "en-us", gender: "Male", grade: "C+" },
  { id: "am_liam", name: "Liam", language: "en-us", gender: "Male", grade: "D" },
  { id: "am_michael", name: "Michael", language: "en-us", gender: "Male", grade: "C+" },
  { id: "am_onyx", name: "Onyx", language: "en-us", gender: "Male", grade: "D" },
  { id: "am_puck", name: "Puck", language: "en-us", gender: "Male", grade: "C+" },
  { id: "am_santa", name: "Santa", language: "en-us", gender: "Male", grade: "D-" },
  { id: "bf_emma", name: "Emma", language: "en-gb", gender: "Female", grade: "B-" },
  { id: "bf_isabella", name: "Isabella", language: "en-gb", gender: "Female", grade: "C" },
  { id: "bm_george", name: "George", language: "en-gb", gender: "Male", grade: "C" },
  { id: "bm_lewis", name: "Lewis", language: "en-gb", gender: "Male", grade: "D+" },
  { id: "bf_alice", name: "Alice", language: "en-gb", gender: "Female", grade: "D" },
  { id: "bf_lily", name: "Lily", language: "en-gb", gender: "Female", grade: "D" },
  { id: "bm_daniel", name: "Daniel", language: "en-gb", gender: "Male", grade: "D" },
  { id: "bm_fable", name: "Fable", language: "en-gb", gender: "Male", grade: "C" },
];

export function isVoiceId(id: string): boolean {
  return VOICES.some((voice) => voice.id === id);
}
