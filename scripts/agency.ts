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
import { formatErrors, typeCheck } from "@/typeChecker.js";
import { Command } from "commander";
import * as fs from "fs";
import { TarsecError } from "tarsec";
import process from "process";
import { remoteRun, upload } from "@/cli/upload.js";

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
  .description("Compile .agency file(s) or directory(s) to JavaScript")
  .argument("<inputs...>", "Paths to .agency input files or directories")
  .action(async (inputs: string[]) => {
    const config = getConfig();
    for (const input of inputs) {
      compile(config, input);
    }
  });

program
  .command("run")
  .description("Compile and run .agency file(s)")
  .argument("[input]", "Paths to .agency input file")
  .action((input: string) => {
    const config = getConfig();
    run(config, input);
  });

program
  .command("format")
  .alias("fmt")
  .description(
    "Format .agency file(s) or directory(s) (reads from stdin if no input)",
  )
  .argument("[inputs...]", "Paths to .agency input files or directories")
  .option("-i, --in-place", "Format file(s) in-place")
  .action(async (inputs: string[], opts: { inPlace?: boolean }) => {
    const config = getConfig();
    if (inputs.length === 0) {
      const contents = await readStdin();
      const formatted = await format(contents, config);
      console.log(formatted);
    } else {
      for (const input of inputs) {
        formatFile(input, opts.inPlace ?? false, config);
      }
    }
  });

program
  .command("ast")
  .alias("parse")
  .description(
    "Parse .agency file(s) and show AST (reads from stdin if no input)",
  )
  .argument("[inputs...]", "Paths to .agency input files")
  .action(async (inputs: string[]) => {
    const config = getConfig();
    if (inputs.length === 0) {
      const contents = await readStdin();
      const result = parse(contents, config);
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const input of inputs) {
        const contents = readFile(input);
        const result = parse(contents, config);
        console.log(JSON.stringify(result, null, 2));
      }
    }
  });

program
  .command("graph")
  .alias("mermaid")
  .description(
    "Render Mermaid graph from .agency file(s) (reads from stdin if no input)",
  )
  .argument("[inputs...]", "Paths to .agency input files")
  .action(async (inputs: string[]) => {
    const config = getConfig();
    if (inputs.length === 0) {
      const contents = await readStdin();
      renderGraph(contents, config);
    } else {
      for (const input of inputs) {
        const contents = readFile(input);
        renderGraph(contents, config);
      }
    }
  });

program
  .command("preprocess")
  .description(
    "Parse .agency file(s) and show AST after preprocessing (reads from stdin if no input)",
  )
  .argument("[inputs...]", "Paths to .agency input files")
  .action(async (inputs: string[]) => {
    const config = getConfig();

    const process = (contents: string) => {
      const parsedProgram = parse(contents, config);
      const preprocessor = new TypescriptPreprocessor(parsedProgram, config);
      preprocessor.preprocess();
      console.log(JSON.stringify(preprocessor.program, null, 2));
    };

    if (inputs.length === 0) {
      const contents = await readStdin();
      process(contents);
    } else {
      for (const input of inputs) {
        const contents = readFile(input);
        process(contents);
      }
    }
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
      await evaluate(getConfig(), target, opts.args, opts.results);
    },
  );

program
  .command("gen-fixtures")
  .alias("fixtures")
  .description("Generate test fixtures")
  .argument("[target]", "Target in file.agency:nodeName format")
  .action(async (target: string | undefined) => {
    await fixtures(getConfig(), target);
  });

program
  .command("test")
  .description("Run tests")
  .argument("[inputs...]", "Paths to .test.json files or directories")
  .action(async (testFile: string[]) => {
    for (const file of testFile) {
      await test(getConfig(), file);
    }
  });

program
  .command("diagnostics")
  .description("Run diagnostics for VSCode")
  .argument("[inputs...]", "Paths to .agency input files")
  .action(async (inputs: string[]) => {
    if (inputs.length === 0) {
      const contents = await readStdin();
      try {
        _parseAgency(contents);
      } catch (error) {
        if (error instanceof TarsecError) {
          console.log(JSON.stringify(error.data, null, 2));
        } else {
          throw error;
        }
      }
    } else {
      for (const input of inputs) {
        const contents = readFile(input);
        try {
          _parseAgency(contents);
        } catch (error) {
          if (error instanceof TarsecError) {
            console.log(JSON.stringify(error.data, null, 2));
          } else {
            throw error;
          }
        }
      }
    }
  });

program
  .command("typecheck")
  .alias("tc")
  .description("Type check .agency file(s) (reads from stdin if no input)")
  .argument("[inputs...]", "Paths to .agency input files")
  .option("--strict", "Enable strict types (untyped variables are errors)")
  .action(async (inputs: string[], opts: { strict?: boolean }) => {
    const config = getConfig();

    let hasErrors = false;
    const runTypeCheck = (contents: string) => {
      const parsedProgram = parse(contents, config);
      const { errors } = typeCheck(parsedProgram, config);
      if (errors.length > 0) {
        console.error(formatErrors(errors));
        hasErrors = true;
      } else {
        console.log("No type errors found.");
      }
    };
    if (opts.strict) config.strictTypes = true;
    if (inputs.length === 0) {
      const contents = await readStdin();
      runTypeCheck(contents);
    } else {
      for (const input of inputs) {
        const contents = readFile(input);
        runTypeCheck(contents);
      }
    }
    if (hasErrors) process.exit(1);
  });

program
  .command("upload")
  .alias("up")
  .alias("deploy")
  .description("Upload files to Statelog")
  .argument("[inputs...]", "Paths to .test.json files or directories")
  .action(async (testFile: string[]) => {
    console.log("Uploading", testFile);
    for (const file of testFile) {
      await upload(getConfig(), file);
    }
  });

program
  .command("remote-run")
  .alias("rr")
  .description("Run files on Statelog remotely")
  .argument("[filename]", "Paths to .test.json files or directories")
  .action(async (filename: string) => {
    console.log("Running files on Statelog remotely");
    await remoteRun(getConfig(), filename);
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
