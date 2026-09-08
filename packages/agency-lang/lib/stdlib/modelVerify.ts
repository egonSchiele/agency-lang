import { createHash } from "node:crypto";
import { wholePath, readStream, move } from "./contained.js";

/** Stream-hash a file's SHA-256 (hex), never buffering the whole file. The
 *  `update` is guarded so a synchronous throw in the data handler rejects the
 *  promise instead of escaping it. */
export function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let stream: ReturnType<typeof readStream>;
    try {
      const located = wholePath(filePath);
      stream = readStream(located.root, located.target);
    } catch (err) {
      reject(err as Error);
      return;
    }
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      try {
        hash.update(chunk);
      } catch (err) {
        stream.destroy();
        reject(err as Error);
      }
    });
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Verify `filePath` against the expected hex SHA-256. On mismatch, rename the
 *  file to `<filePath>.invalidSha` (kept for inspection; won't be picked up, so
 *  the next run re-downloads) and throw. A failed rename is logged (not
 *  swallowed) and reflected in the thrown message. */
export async function verifyModelFile(
  filePath: string,
  expected: string,
  name: string,
): Promise<void> {
  // `fileSha256` returns lowercase hex; normalize the expected pin so a
  // valid-but-uppercase hash (e.g. from a hand-written alias) still matches.
  const want = expected.toLowerCase();
  const actual = await fileSha256(filePath);
  if (actual === want) return;
  const quarantine = `${filePath}.invalidSha`;
  let moved = true;
  try {
    move(wholePath(filePath), wholePath(quarantine));
  } catch (err) {
    moved = false;
    console.warn(`Could not move "${filePath}" to "${quarantine}" after SHA-256 mismatch:`, err);
  }
  throw new Error(
    `SHA-256 verification failed for "${name}": expected ${expected}, got ${actual}. ` +
      (moved
        ? `The downloaded file was moved to ${quarantine} for inspection and will be re-downloaded next time.`
        : `The downloaded file at ${filePath} could NOT be moved aside — delete it manually before re-running.`),
  );
}
