import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { ZodSchema } from "zod";

import { runAgencyNode } from "@/cli/util.js";
import type { AgencyConfig } from "@/config.js";

import type { JSON } from "./types.js";

/** Seam over runAgencyNode so callers/tests can inject a fake. */
export type NodeRunner = (args: {
  config: AgencyConfig;
  agencyFile: string;
  nodeName: string;
  hasArgs: boolean;
  argsString: string;
  scratchDir: string;
  quietCompile: boolean;
}) => Promise<{ data: unknown }>;

const defaultRunner: NodeRunner = (args) => runAgencyNode(args);

/**
 * Runs .agency nodes for the optimizer: the agent under test (`run`) and
 * judge/proposer agents (`runStructured`, zod-validated). Wraps the general
 * `runAgencyNode` core; the `runNode` seam keeps it unit-testable.
 */
export class AgencyRunner {
  constructor(
    private readonly config: AgencyConfig,
    private readonly runNode: NodeRunner = defaultRunner,
  ) {}

  /** Run an agent node and return its raw value. `args` are positional, in node-parameter order. */
  async run(agencyFile: string, nodeName: string, args: JSON[]): Promise<JSON> {
    const { data } = await this.exec(agencyFile, nodeName, args);
    return data as JSON;
  }

  /** Run a judge/proposer node and validate its structured return against a schema. */
  async runStructured<T>(agencyFile: string, nodeName: string, args: JSON[], schema: ZodSchema<T>): Promise<T> {
    const { data } = await this.exec(agencyFile, nodeName, args);
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${agencyFile}: structured return failed schema validation: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  private async exec(agencyFile: string, nodeName: string, args: JSON[]): Promise<{ data: unknown }> {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-runner-"));
    try {
      const config = { ...this.config };
      delete config.distDir;
      const argsString = args.map((v) => globalThis.JSON.stringify(v)).join(", ");
      return await this.runNode({ config, agencyFile, nodeName, hasArgs: args.length > 0, argsString, scratchDir, quietCompile: true });
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}
