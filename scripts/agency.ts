#!/usr/bin/env node
import {
  compile,
  format,
  formatFile,
  loadConfig,
  parse,
  readFile,
  readStdin,
  renderGraph,
  run,
} from "@/cli/commands.js";
import { evaluate } from "@/cli/evaluate.js";
import { fixtures, test } from "@/cli/test.js";
import { AgencyConfig } from "@/config.js";
import { _parseAgency } from "@/parser.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { Command } from "commander";
import * as fs from "fs";
import { failure, TarsecError } from "tarsec";

const program = new Command();

program
  .name("agency")
  .description("Agency Language CLI")
  .version("0.0.52")
  .option("-v, --verbose", "Enable verbose logging during parsing")
  .option("-c, --config <path>", "Path to agency.json config file");

function getConfig(): AgencyConfig {
  const opts = program.opts();
  const config = loadConfig(opts.config, opts.verbose);
  if (opts.verbose) {
    config.verbose = true;
  }
  return config;
}

program
  .command("compile")
  .alias("build")
  .description("Compile .agency file or directory to JavaScript")
  .argument("<input>", "Path to .agency input file or directory")
  .argument("[output]", "Path to output .js file (optional)")
  .action((input: string, output: string | undefined) => {
    compile(getConfig(), input, output);
  });

program
  .command("run")
  .description("Compile and run .agency file")
  .argument("<input>", "Path to .agency input file")
  .argument("[output]", "Path to output .js file (optional)")
  .action((input: string, output: string | undefined) => {
    run(getConfig(), input, output);
  });

program
  .command("format")
  .alias("fmt")
  .description(
    "Format .agency file or directory (reads from stdin if no input)",
  )
  .argument("[input]", "Path to .agency input file or directory")
  .option("-i, --in-place", "Format file(s) in-place")
  .action(async (input: string | undefined, opts: { inPlace?: boolean }) => {
    const config = getConfig();
    if (!input) {
      const contents = await readStdin();
      const formatted = await format(contents, config);
      console.log(formatted);
    } else {
      formatFile(input, opts.inPlace ?? false, config);
    }
  });

program
  .command("ast")
  .alias("parse")
  .description("Parse .agency file and show AST (reads from stdin if no input)")
  .argument("[input]", "Path to .agency input file")
  .action(async (input: string | undefined) => {
    const config = getConfig();
    let contents;
    if (!input) {
      contents = await readStdin();
    } else {
      contents = readFile(input);
    }
    const result = parse(contents, config);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("graph")
  .alias("mermaid")
  .description(
    "Render Mermaid graph from .agency file (reads from stdin if no input)",
  )
  .argument("[input]", "Path to .agency input file")
  .action(async (input: string | undefined) => {
    const config = getConfig();
    let contents;
    if (!input) {
      contents = await readStdin();
    } else {
      contents = readFile(input);
    }
    renderGraph(contents, config);
  });

program
  .command("preprocess")
  .description(
    "Parse .agency file and show AST after preprocessing (reads from stdin if no input)",
  )
  .argument("[input]", "Path to .agency input file")
  .action(async (input: string | undefined) => {
    const config = getConfig();
    let contents;
    if (!input) {
      contents = await readStdin();
    } else {
      contents = readFile(input);
    }
    const parsedProgram = parse(contents, config);
    const preprocessor = new TypescriptPreprocessor(parsedProgram, config);
    preprocessor.preprocess();
    console.log(JSON.stringify(preprocessor.program, null, 2));
  });

program
  .command("evaluate")
  .alias("eval")
  .description("Run evaluation")
  .argument("[target]", "Target in file.agency:nodeName format")
  .option("--args <path>", "Path to eval args JSON file")
  .option("--results <path>", "Path to existing results file (to resume)")
  .action(
    async (
      target: string | undefined,
      opts: { args?: string; results?: string },
    ) => {
      await evaluate(target, opts.args, opts.results);
    },
  );

program
  .command("gen-fixtures")
  .alias("fixtures")
  .description("Generate test fixtures")
  .argument("[target]", "Target in file.agency:nodeName format")
  .action(async (target: string | undefined) => {
    await fixtures(target);
  });

program
  .command("test")
  .description("Run tests")
  .argument("[testFile]", "Path to .test.json file")
  .action(async (testFile: string | undefined) => {
    await test(testFile);
  });

program
  .command("diagnostics")
  .description("Run diagnostics for VSCode")
  .argument("[testFile]", "Path to .test.json file")
  .action(async (testFile: string | undefined) => {
    const contents = testFile ? readFile(testFile) : await readStdin();

    try {
      _parseAgency(contents);
    } catch (error) {
      if (error instanceof TarsecError) {
        console.log(JSON.stringify(error.data, null, 2));
      } else {
        throw error;
      }
    }
  });

// Default: treat unknown args as a file to run
program.arguments("[file]").action((file: string | undefined) => {
  if (!file) {
    program.help();
    return;
  }
  if (file.endsWith(".agency") || fs.existsSync(file)) {
    const args = program.args;
    const output = args.length > 1 ? args[1] : undefined;
    run(getConfig(), file, output);
  } else {
    console.error(`Error: Unknown command '${file}'`);
    console.error("Run 'agency help' for usage information");
    process.exit(1);
  }
});

program.parse();
