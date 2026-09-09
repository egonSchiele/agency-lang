// Every entry here must have a real pinned URL and SHA-256 in
// models.lock.json. To add a language, run
// `TESSDATA_COMMIT=<sha> bash scripts/generate-lockfile.sh <lang>`, confirm
// the printed hash against the tessdata_fast repository, paste the row
// into models.lock.json, and add the name here.
export const KNOWN_LANGUAGES = ["eng"] as const;

export type LanguageName = (typeof KNOWN_LANGUAGES)[number];

export type LockfileEntry = {
  url: string;
  sha256: string;
  sizeBytes: number;
};

export type Lockfile = {
  schemaVersion: 1;
  languages: Record<LanguageName, LockfileEntry>;
};
