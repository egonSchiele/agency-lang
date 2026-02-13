export function help(): void {
  console.log(`
Agency Language CLI

Usage:
  agency help                           Show this help message
  agency compile <input> [output]       Compile .agency file or directory to TypeScript
  agency run <input> [output]           Compile and run .agency file
  agency format [input]                 Format .agency file or directory (reads from stdin if no input)
  agency format -i <input>              Format .agency file or directory in-place
  agency ast [input]                    Parse .agency file and show AST (reads from stdin if no input)
  agency preprocess [input]             Parse .agency file and show AST after preprocessing (reads from stdin if no input)
  agency graph [input]                  Render Mermaid graph from .agency file (reads from stdin if no input)
  agency <input>                        Compile and run .agency file (shorthand)

Arguments:
  input                                 Path to .agency input file or directory (or omit to read from stdin for format/parse)
  output                                Path to output .ts file (optional, ignored for directories)
                                        Default: <input-name>.ts

Flags:
  -v, --verbose                         Enable verbose logging during parsing
  -i, --in-place                        Format file(s) in-place (use with format command)
  -c, --config <path>                   Path to agency.json config file (default: ./agency.json)

Config File (agency.json):
  {
    "verbose": false,                   Enable verbose logging by default
    "outDir": "./dist",                 Default output directory for compiled files
    "excludeNodeTypes": ["comment"],    Node types to exclude from code generation
    "excludeBuiltinFunctions": ["write"], Builtin functions to exclude
    "allowedFetchDomains": ["api.example.com"], Whitelist for fetch domains
    "disallowedFetchDomains": ["blocked.com"]   Blacklist for fetch domains
  }

Examples:
  agency help                           Show help
  agency compile script.agency          Compile to script.ts
  agency compile script.agency out.ts   Compile to out.ts
  agency compile ./scripts              Compile all .agency files in directory
  agency run script.agency              Compile and run script.agency
  agency -v parse script.agency         Parse with verbose logging
  agency -c config.json compile script  Use custom config file
  agency format script.agency           Format and print to stdout
  agency format -i script.agency        Format file in-place
  agency format -i ./scripts            Format all .agency files in directory in-place
  cat script.agency | agency format     Format from stdin
  echo "x = 5" | agency parse           Parse from stdin
  agency script.agency                  Compile and run (shorthand)
`);
}
