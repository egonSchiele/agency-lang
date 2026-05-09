import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import os from "os";
import { validatePolicy } from "../runtime/policy.js";
import type { Policy } from "../runtime/policy.js";

export type { Policy } from "../runtime/policy.js";

export class PolicyStore {
  private policy: Policy = {};
  private filePath: string;

  constructor(serverName: string, baseDir?: string) {
    const dir = path.join(baseDir ?? path.join(os.homedir(), ".agency", "serve"), serverName);
    this.filePath = path.join(dir, "policy.json");
    this.load();
  }

  get(): Readonly<Policy> {
    return this.policy;
  }

  set(policy: Policy): void {
    const result = validatePolicy(policy);
    if (!result.success) throw new Error(result.error);
    this.policy = policy;
    this.save();
  }

  clear(): void {
    this.policy = {};
    this.save();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
      const result = validatePolicy(parsed);
      if (result.success) {
        this.policy = parsed;
      } else {
        console.error(`Invalid policy file at ${this.filePath}: ${result.error}. Using empty policy.`);
      }
    } catch {
      console.error(`Failed to parse policy file at ${this.filePath}. Using empty policy.`);
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, JSON.stringify(this.policy, null, 2), { mode: 0o600 });
  }
}
