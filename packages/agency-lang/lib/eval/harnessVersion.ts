import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/** The harness's own version, for a `run` row's annotator id. */
export function harnessVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 5; index += 1) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string };
        return parsed.version ?? "unknown";
      } catch {
        return "unknown";
      }
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}
