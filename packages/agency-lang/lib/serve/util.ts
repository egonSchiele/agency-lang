export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toArgs(body: unknown): Record<string, unknown> {
  return (body as Record<string, unknown>) ?? {};
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export function parseJsonBody(
  req: { on: (event: string, cb: (...args: any[]) => void) => void; destroy?: () => void },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy?.();
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
