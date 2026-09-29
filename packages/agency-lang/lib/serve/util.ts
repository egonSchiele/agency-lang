export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toArgs(body: unknown): Record<string, unknown> {
  if (body != null && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

import { MAX_BODY_BYTES } from "./constants.js";

/** The request's JSON body. Rejects a body over `maxBytes`, which is
 *  10 MB unless the caller serves a route that takes more.
 *
 *  `drainBytes` says what happens to the rest of a body that is too large.
 *  With 0, the request is destroyed at once, and a client that is still
 *  sending sees a dropped connection. With more, up to that many further
 *  bytes are read and thrown away, so the client can finish sending and
 *  read the caller's reply. Past that, the request is destroyed. */
export function parseJsonBody(
  req: {
    on: (event: string, cb: (...args: any[]) => void) => void;
    destroy?: () => void;
  },
  maxBytes: number = MAX_BODY_BYTES,
  drainBytes: number = 0,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // Nothing of a refused body is kept.
        chunks.length = 0;
        if (bytes > maxBytes + drainBytes) {
          req.destroy?.();
        }
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
