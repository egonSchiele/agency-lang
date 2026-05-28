import { validatePolicy } from "@/runtime/policy.js";
import { writeFileSync } from "fs";
import path from "path";
import process from "process";
import { assertContained } from "./assertContained.js";
export { checkPolicy as _checkPolicy, validatePolicy as _validatePolicy } from "@/runtime/policy.js";
import type { Policy } from "@/runtime/policy.js";

export async function _writePolicyFile(
  filePath: string,
  policy: Policy,
  allowedPaths?: string[],
) {
  const result = validatePolicy(policy);
  if (!result.success) throw new Error(`Invalid policy: ${result.error}`);
  const full = path.resolve(process.cwd(), filePath);
  await assertContained(full, allowedPaths ?? []);
  writeFileSync(full, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
}
