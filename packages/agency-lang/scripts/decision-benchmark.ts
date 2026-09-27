#!/usr/bin/env node
import { main, convertSms } from "./decisionBenchmark/cli.js";

try {
  const args = process.argv.slice(2);
  if (args[0] === "import-sms") {
    if (args.length !== 3) {
      throw new Error("Usage: benchmark:decisions import-sms SMSSpamCollection cases.jsonl");
    }
    convertSms(args[1], args[2]);
  } else {
    await main(args);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
