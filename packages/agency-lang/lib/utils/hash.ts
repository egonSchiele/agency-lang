import crypto from "crypto";

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
