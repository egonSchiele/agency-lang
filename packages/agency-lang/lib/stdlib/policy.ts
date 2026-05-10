import { validatePolicy } from "@/runtime/policy.js";
import { writeFileSync } from "fs";
export { checkPolicy as _checkPolicy, validatePolicy as _validatePolicy } from "@/runtime/policy.js";

export function _writePolicyFile(filePath: string, policy: any) {
  const result = validatePolicy(policy);
  if (!result.success) throw new Error(`Invalid policy: ${result.error}`);
  writeFileSync(filePath, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
}
