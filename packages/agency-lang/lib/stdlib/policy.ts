import { validatePolicy } from "@/runtime/policy.js";
import { writeFileSync } from "fs";
import { resolveDir } from "./resolveDir.js";
export { checkPolicy as _checkPolicy, validatePolicy as _validatePolicy } from "@/runtime/policy.js";
import type { Policy } from "@/runtime/policy.js";

export async function _writePolicyFile(
  filePath: string,
  policy: Policy,
  allowedPaths?: string[],
) {
  const result = validatePolicy(policy);
  if (!result.success) throw new Error(`Invalid policy: ${result.error}`);
  // `resolveDir` (cwd-anchored) handles `~` expansion + allow-list
  // enforcement uniformly with the fs.ts / system.ts / speech.ts call sites.
  const full = await resolveDir(filePath, allowedPaths ?? [], "cwd");
  writeFileSync(full, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
}
