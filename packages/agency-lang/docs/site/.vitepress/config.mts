import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Agency",
  description: "A language for creating agents.",
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "CLI", link: "/cli/index" },
      { text: "Standard Library", link: "/stdlib/overview" },
      { text: "Packages", link: "/packages/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Basic",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Agents 101", link: "/guide/agents-101" },
            { text: "Basic Syntax", link: "/guide/basic-syntax" },
            { text: "Types", link: "/guide/types" },
            { text: "Nodes", link: "/guide/nodes" },
            { text: "LLMs", link: "/guide/llm" },
            { text: "Functions", link: "/guide/functions" },
            {
              text: "Imports and Packages",
              link: "/guide/imports-and-packages",
            },
            { text: "TypeScript Interoperability", link: "/guide/ts-interop" },
            { text: "Odds and Ends", link: "/guide/odds-and-ends" },
          ],
        },
        {
          text: "Intermediate",
          items: [
            { text: "Interrupts", link: "/guide/interrupts" },
            { text: "Handlers", link: "/guide/handlers" },
            {
              text: "Structured Interrupts",
              link: "/guide/structured-interrupts",
            },
            { text: "PFAs", link: "/guide/partial-application" },
            {
              text: "Message History and Threads",
              link: "/guide/message-history-and-threads",
            },
            { text: "Error Handling", link: "/guide/error-handling" },
            { text: "Blocks", link: "/guide/blocks" },
            { text: "Execution Model", link: "/guide/execution-model" },
            { text: "Testing", link: "/guide/testing" },
          ],
        },
        {
          text: "Advanced",
          items: [
            { text: "Concurrency", link: "/guide/concurrency" },
            { text: "Policies", link: "/guide/policies" },
            { text: "Debugger", link: "/guide/debugger" },
            { text: "Traces and Bundles", link: "/guide/traces-and-bundles" },
            { text: "Schemas", link: "/guide/schemas" },
            { text: "Checkpointing", link: "/guide/checkpointing" },
            { text: "MCP", link: "/guide/mcp" },
          ],
        },
        {
          text: "Appendix",
          items: [
            { text: "Agency CLI", link: "/appendix/cli" },
            { text: "VSCode Extension", link: "/appendix/vscode-extension" },
            { text: "Generating Docs", link: "/appendix/docs" },
            { text: "Callbacks", link: "/appendix/callbacks" },
            {
              text: "Agency vs TypeScript",
              link: "/appendix/agency-vs-typescript",
            },
            {
              text: "Agency's Standard Library",
              link: "/appendix/agency-stdlib",
            },
          ],
        },
      ],
      "/appendix/": [
        {
          text: "Guide",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Basic Syntax", link: "/guide/basic-syntax" },
            { text: "Types", link: "/guide/types" },
            { text: "Nodes", link: "/guide/nodes" },
            { text: "LLMs", link: "/guide/llm" },
            { text: "Functions", link: "/guide/functions" },
            { text: "Interrupts", link: "/guide/interrupts" },
            { text: "Handlers", link: "/guide/handlers" },
            { text: "Testing", link: "/guide/testing" },
            { text: "TypeScript Interoperability", link: "/guide/ts-interop" },
            {
              text: "Message History and Threads",
              link: "/guide/message-history-and-threads",
            },
            { text: "Error Handling", link: "/guide/error-handling" },
            { text: "Debugger", link: "/guide/debugger" },
            { text: "Traces and Bundles", link: "/guide/traces-and-bundles" },
            { text: "Blocks", link: "/guide/blocks" },
            { text: "Fork", link: "/guide/fork" },
            { text: "Execution Model", link: "/guide/execution-model" },
            {
              text: "Imports and Packages",
              link: "/guide/imports-and-packages",
            },
            { text: "Schemas", link: "/guide/schemas" },
            { text: "Checkpointing", link: "/guide/checkpointing" },
            { text: "MCP", link: "/guide/mcp" },
          ],
        },
        {
          text: "Appendix",
          items: [
            { text: "Agency CLI", link: "/appendix/cli" },
            { text: "VSCode Extension", link: "/appendix/vscode-extension" },
            { text: "Generating Docs", link: "/appendix/docs" },
            { text: "Callbacks", link: "/appendix/callbacks" },
            {
              text: "Agency vs TypeScript",
              link: "/appendix/agency-vs-typescript",
            },
            {
              text: "Agency's Standard Library",
              link: "/appendix/agency-stdlib",
            },
          ],
        },
      ],

      "/cli/": [
        {
          text: "CLI",
          items: [
            { text: "Overview", link: "/cli/index" },
            { text: "agent", link: "/cli/agent" },
            { text: "compile", link: "/cli/compile" },
            { text: "debug", link: "/cli/debug" },
            { text: "doc", link: "/cli/doc" },
            { text: "format", link: "/cli/format" },
            { text: "lsp / mcp", link: "/cli/editor-integration" },
            { text: "optimize", link: "/cli/optimize" },
            { text: "preprocess / ast", link: "/cli/preprocess-and-ast" },
            { text: "policy", link: "/cli/policy" },
            { text: "review", link: "/cli/review" },
            { text: "run", link: "/cli/run" },
            { text: "schedule", link: "/cli/schedule" },
            { text: "serve", link: "/cli/serve" },
            { text: "test", link: "/cli/test" },
            { text: "trace", link: "/cli/trace-and-bundle" },
            { text: "bundle", link: "/cli/trace-and-bundle" },
            { text: "typecheck", link: "/cli/typecheck" },
          ],
        },
      ],

      "/stdlib/": [
        {
          text: "Standard Library",
          items: [
            { text: "Overview", link: "/stdlib/overview" },
            { text: "agency", link: "/stdlib/agency" },
            { text: "agent", link: "/stdlib/agent" },
            { text: "array", link: "/stdlib/array" },
            { text: "browser", link: "/stdlib/browser" },
            { text: "calendar", link: "/stdlib/calendar" },
            { text: "clipboard", link: "/stdlib/clipboard" },
            { text: "date", link: "/stdlib/date" },
            { text: "email", link: "/stdlib/email" },
            { text: "fs", link: "/stdlib/fs" },
            { text: "http", link: "/stdlib/http" },
            { text: "imessage", link: "/stdlib/imessage" },
            { text: "keyring", link: "/stdlib/keyring" },
            { text: "math", link: "/stdlib/math" },
            { text: "oauth", link: "/stdlib/oauth" },
            { text: "object", link: "/stdlib/object" },
            { text: "path", link: "/stdlib/path" },
            { text: "policy", link: "/stdlib/policy" },
            { text: "retry", link: "/stdlib/retry" },
            { text: "shell", link: "/stdlib/shell" },
            { text: "sms", link: "/stdlib/sms" },
            { text: "speech", link: "/stdlib/speech" },
            { text: "strategy", link: "/stdlib/strategy" },
            { text: "system", link: "/stdlib/system" },
            { text: "ui", link: "/stdlib/ui" },
            { text: "weather", link: "/stdlib/weather" },
            { text: "wikipedia", link: "/stdlib/wikipedia" },
          ],
        },
      ],
      "/packages/": [
        {
          text: "Packages",
          items: [
            { text: "Overview", link: "/packages/" },
            { text: "brave-search", link: "/packages/brave-search/" },
            { text: "web-fetch", link: "/packages/web-fetch/" },
            { text: "mcp", link: "/packages/mcp/" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/egonSchiele/agency-lang" },
    ],
  },
});
