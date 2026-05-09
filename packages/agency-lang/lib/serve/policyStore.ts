import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import os from "os";
import { validatePolicy } from "../runtime/policy.js";
import type { Policy, PolicyRule } from "../runtime/policy.js";

export type { Policy, PolicyRule } from "../runtime/policy.js";

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

  addRule(kind: string, rule: PolicyRule): void {
    if (!kind || typeof kind !== "string") throw new Error("kind must be a non-empty string");
    if (kind === "__proto__" || kind === "constructor") throw new Error(`Invalid kind: '${kind}'`);
    if (!rule || typeof rule !== "object") throw new Error("rule must be an object");
    if (rule.action !== "approve" && rule.action !== "reject") {
      throw new Error(`Invalid action: '${rule.action}'. Must be 'approve' or 'reject'.`);
    }
    if (rule.match !== undefined) {
      if (typeof rule.match !== "object" || rule.match === null) throw new Error("match must be an object");
      for (const v of Object.values(rule.match)) {
        if (typeof v !== "string") throw new Error("match values must be strings (glob patterns)");
      }
    }
    if (!this.policy[kind]) this.policy[kind] = [];
    this.policy[kind].push(rule);
    this.save();
  }

  removeRule(kind: string, index: number): void {
    if (!Number.isFinite(index) || !Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid index: ${index}. Must be a non-negative integer.`);
    }
    const rules = this.policy[kind];
    if (!rules || index >= rules.length) {
      throw new Error(`No rule at index ${index} for kind '${kind}'`);
    }
    const updated = rules.filter((_, i) => i !== index);
    if (updated.length === 0) {
      delete this.policy[kind];
    } else {
      this.policy[kind] = updated;
    }
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
