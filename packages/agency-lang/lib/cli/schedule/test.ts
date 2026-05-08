import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { scheduleAdd } from "./index.js";

export type TestOptions = { baseDir?: string; cwd?: string };

export type TestResult = {
  name: string;
  agentFile: string;
  outputFile: string;
  logDir: string;
};

export const TEST_SCHEDULE_NAME = "agency-cron-test";
export const TEST_OUTPUT_FILE = "agency-cron-test.txt";
export const TEST_AGENT_FILE = "agency-cron-test.agency";

const TEST_AGENT_CONTENT = `import { now } from "std::date"

node main() {
  write("${TEST_OUTPUT_FILE}", now()) with approve
}
`;

export function scheduleTest(opts: TestOptions = {}): TestResult {
  const cwd = opts.cwd ?? process.cwd();
  const agentFile = path.join(cwd, TEST_AGENT_FILE);
  const outputFile = path.join(cwd, TEST_OUTPUT_FILE);

  fs.writeFileSync(agentFile, TEST_AGENT_CONTENT);

  scheduleAdd({
    file: agentFile,
    every: "minute",
    name: TEST_SCHEDULE_NAME,
    baseDir: opts.baseDir,
    force: true,
  });

  const baseDir = opts.baseDir ?? path.join(os.homedir(), ".agency", "schedules");
  const logDir = path.join(baseDir, TEST_SCHEDULE_NAME, "logs");

  return { name: TEST_SCHEDULE_NAME, agentFile, outputFile, logDir };
}
