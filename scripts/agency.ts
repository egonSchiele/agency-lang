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
import { evaluate, test } from "@/cli/evaluate.js";
import { help } from "@/cli/help.js";
import { AgencyConfig } from "@/config.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import * as fs from "fs";

let config: AgencyConfig = {};

// Main CLI logic
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // No arguments - show help
  if (args.length === 0) {
    help();
    return;
  }

  // Extract config flag
  const configIndex = args.findIndex(
    (arg) => arg === "-c" || arg === "--config",
  );
  let configPath: string | undefined;
  if (configIndex !== -1 && args[configIndex + 1]) {
    configPath = args[configIndex + 1];
  }

  // Load configuration
  config = loadConfig(configPath);

  // Extract verbose flag
  const verboseIndex = args.findIndex(
    (arg) => arg === "-v" || arg === "--verbose",
  );
  // CLI flag overrides config file
  const verbose = verboseIndex !== -1 || (config.verbose ?? false);
  config.verbose = verbose;
  // Remove flags from args
  let filteredArgs = args.filter(
    (arg, index) =>
      arg !== "-v" &&
      arg !== "--verbose" &&
      arg !== "-c" &&
      arg !== "--config" &&
      // Remove the config path value if it follows the -c flag
      !(
        (args[index - 1] === "-c" || args[index - 1] === "--config") &&
        index === configIndex + 1
      ),
  );

  const command = filteredArgs[0];

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    case "build":
    case "compile":
      if (filteredArgs.length < 2) {
        console.error(
          "Error: 'compile' command requires an input file or directory",
        );
        console.error("Usage: agency compile <input> [output]");
        process.exit(1);
      }
      compile(config, filteredArgs[1], filteredArgs[2]);
      break;

    case "run":
      if (filteredArgs.length < 2) {
        console.error("Error: 'run' command requires an input file");
        console.error("Usage: agency run <input> [output]");
        process.exit(1);
      }
      run(config, filteredArgs[1], filteredArgs[2]);
      break;

    case "fmt":
    case "format":
      // Extract -i flag
      const inPlaceIndex = filteredArgs.findIndex(
        (arg) => arg === "-i" || arg === "--in-place",
      );
      const inPlace = inPlaceIndex !== -1;

      // Remove -i flag from args
      const formatArgs = filteredArgs.filter(
        (arg) => arg !== "-i" && arg !== "--in-place",
      );

      if (formatArgs.length < 2) {
        // Read from stdin
        const fmtContents = await readStdin();
        const formatted = await format(fmtContents, config);
        console.log(formatted);
      } else {
        // Read from file or directory
        formatFile(formatArgs[1], inPlace, config);
      }
      break;

    case "ast":
    case "parse":
      let contents;
      if (filteredArgs.length < 2) {
        contents = await readStdin();
      } else {
        contents = readFile(filteredArgs[1]);
      }
      const result = parse(contents, config);
      console.log(JSON.stringify(result, null, 2));
      break;

    case "mermaid":
    case "graph":
      let graphContents;
      if (filteredArgs.length < 2) {
        graphContents = await readStdin();
      } else {
        graphContents = readFile(filteredArgs[1]);
      }
      renderGraph(graphContents, config);
      break;
    case "preprocess":
      let preContents;
      if (filteredArgs.length < 2) {
        preContents = await readStdin();
      } else {
        preContents = readFile(filteredArgs[1]);
      }
      const parsedProgram = parse(preContents, config);
      const preprocessor = new TypescriptPreprocessor(parsedProgram, config);
      preprocessor.preprocess();
      console.log(JSON.stringify(preprocessor.program, null, 2));
      break;
    case "evaluate":
      await evaluate();
      break;
    case "test":
      await test();
      break;

    default:
      // If first arg is not a recognized command, treat it as a file to run
      if (command.endsWith(".agency") || fs.existsSync(command)) {
        run(config, command, filteredArgs[1]);
      } else {
        console.error(`Error: Unknown command '${command}'`);
        console.error("Run 'agency help' for usage information");
        process.exit(1);
      }
      break;
  }
}

main();
