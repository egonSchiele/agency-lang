import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import os from "os";
import { validatePolicy } from "../runtime/policy.js";

type PolicyRule = {
  match?: Record<string, string>;
  action: "approve" | "reject" | "propagate";
};

export type Policy = Record<string, PolicyRule[]>;

export class PolicyStore {
  private policy: Policy = {};
  private filePath: string;

  constructor(serverName: string, baseDir?: string) {
    const dir = path.join(baseDir ?? path.join(os.homedir(), ".agency", "serve"), serverName);
    this.filePath = path.join(dir, "policy.json");
    this.load();
  }

  get(): Policy {
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
    this.policy = JSON.parse(readFileSync(this.filePath, "utf-8"));
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, JSON.stringify(this.policy, null, 2), { mode: 0o600 });
  }
}
