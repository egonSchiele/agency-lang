// Writes a saved-workflow file the way another process would, with no
// interrupt, so a test can change the folder while a review is pending.
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export function saveElsewhere(dir, name, text) {
  mkdirSync(join(dir, "workflows"), { recursive: true });
  writeFileSync(join(dir, "workflows", `${name}.json`), text);
}
