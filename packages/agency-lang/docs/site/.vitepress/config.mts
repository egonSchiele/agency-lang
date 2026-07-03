import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Agency",
  description: "A language for creating agents.",
  themeConfig: {
    outline: "deep",
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "CLI", link: "/cli/index" },
      { text: "Standard Library", link: "/stdlib/index" },
      { text: "Packages", link: "/packages/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "01. Basics",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Basic Syntax", link: "/guide/basic-syntax" },
            { text: "Types", link: "/guide/types" },
            { text: "The `main` Node", link: "/guide/the-main-node" },

            { text: "LLM Calls", link: "/guide/llm" },
            { text: "Functions", link: "/guide/functions" },
            {
              text: "Imports and Packages",
              link: "/guide/imports-and-packages",
            },
            { text: "TypeScript Interoperability", link: "/guide/ts-interop" },
            {
              text: "Common Functions",
              link: "/guide/common-functions",
            },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
            { text: "Exercise 1", link: "/guide/exercise-1" },
          ],
        },
        {
          text: "02. Safety, Part 1",
          items: [
            { text: "Interrupts", link: "/guide/interrupts" },
            {
              text: "Partial Function Application",
              link: "/guide/partial-application",
            },
            { text: "Handlers", link: "/guide/handlers" },
            {
              text: "Effects",
              link: "/guide/effects",
            },
          ],
        },
        {
          text: "03. Basics, Part 2",
          items: [
            { text: "Error Handling", link: "/guide/error-handling" },
            { text: "Blocks", link: "/guide/blocks" },
            { text: "Pattern Matching", link: "/guide/pattern-matching" },
            { text: "Nodes", link: "/guide/nodes" },
            // TS interop part 2, including handling interrupts, cancellation
          ],
        },
        {
          text: "04. LLMs",
          items: [
            {
              text: "LLM Calls, Part 2",
              link: "/guide/llm-part-2",
            },
            {
              text: "Message Threads",
              link: "/guide/message-threads",
            },

            { text: "Guards", link: "/guide/guards" },
            { text: "Image generation", link: "/guide/image-generation" },
            // attachments
            // streaming
          ],
        },
        {
          text: "05. Safety, Part 2",
          items: [
            {
              text: "Effect Sets and raises",
              link: "/guide/effects-and-raises",
            },
            { text: "Policies", link: "/guide/policies" },
          ],
        },
        {
          text: "06. Agency's Execution Model",
          items: [
            { text: "Execution Model", link: "/guide/execution-model" },
            {
              text: "Global vs Static Variables",
              link: "/guide/global-vs-static",
            },
            { text: "Checkpointing", link: "/guide/checkpointing" },
            {
              text: "Cross-Thread Context Sharing",
              link: "/guide/cross-thread-context",
            },
            // Initializer dependencies
          ],
        },
        {
          text: "Advanced",
          items: [
            { text: "Testing", link: "/guide/testing" },
            { text: "Observability", link: "/guide/observability" },
            { text: "Concurrency", link: "/guide/concurrency" },
            { text: "Schemas", link: "/guide/schemas" },
            { text: "Type Validation", link: "/guide/type-validation" },
            { text: "Memory", link: "/guide/memory" },
            { text: "MCP", link: "/guide/mcp" },
            { text: "Serving Agency Code", link: "/guide/serving" },
            {
              text: "Custom & local model providers",
              link: "/guide/custom-providers",
            },
          ],
        },
        {
          text: "Appendix",
          items: [
            { text: "VSCode Extension", link: "/guide/vscode-extension" },
            { text: "Callbacks", link: "/guide/callbacks" },
            {
              text: "Agency vs TypeScript",
              link: "/guide/agency-vs-typescript",
            },
            {
              text: "Agency's Standard Library",
              link: "/guide/agency-stdlib",
            },
            {
              text: "Agency Packages",
              link: "/guide/agency-packages",
            },
            {
              text: "Built-in Functions",
              link: "/guide/builtins",
            },
            {
              text: "Advanced Types",
              link: "/guide/advanced-types",
            },
            {
              text: "TypeScript Helpers (agency.*)",
              link: "/guide/ts-helpers",
            },
            { text: "Agency Config File", link: "/guide/agency-config-file" },
            { text: "CLI Argument Parsing", link: "/guide/cli-args" },
            {
              text: "Schema Parameter Injection",
              link: "/guide/schema-parameter-injection",
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
            { text: "bundle", link: "/cli/trace-and-bundle" },
            { text: "compile", link: "/cli/compile" },
            { text: "coverage", link: "/cli/coverage" },
            { text: "debug", link: "/cli/debug" },
            { text: "doc", link: "/cli/doc" },
            { text: "eval", link: "/cli/eval" },
            { text: "eval-judge", link: "/cli/eval-judge" },
            { text: "format", link: "/cli/format" },
            { text: "local", link: "/cli/local" },
            { text: "lsp / mcp", link: "/cli/editor-integration" },
            { text: "models", link: "/cli/models" },
            { text: "optimize", link: "/cli/optimize" },
            { text: "pack", link: "/cli/pack" },
            { text: "policy", link: "/cli/policy" },
            { text: "preprocess / ast", link: "/cli/preprocess-and-ast" },
            { text: "review", link: "/cli/review" },
            { text: "run", link: "/cli/run" },
            { text: "schedule", link: "/cli/schedule" },
            { text: "serve", link: "/cli/serve" },
            { text: "test", link: "/cli/test" },
            { text: "trace", link: "/cli/trace-and-bundle" },
            { text: "typecheck", link: "/cli/typecheck" },
          ],
        },
      ],

      "/stdlib/": [
        {
          text: "Standard Library",
          items: [
            {
              text: "agency",
              collapsed: false,
              items: [
                { text: "agency", link: "/stdlib/agency" },
                { text: "agency/eval", link: "/stdlib/agency/eval" },
                { text: "agency/local", link: "/stdlib/agency/local" },
              ],
            },
            { text: "agent", link: "/stdlib/agent" },
            { text: "args", link: "/stdlib/args" },
            { text: "array", link: "/stdlib/array" },
            {
              text: "auth",
              collapsed: false,
              items: [
                { text: "auth/keyring", link: "/stdlib/auth/keyring" },
                { text: "auth/oauth", link: "/stdlib/auth/oauth" },
              ],
            },
            { text: "calendar", link: "/stdlib/calendar" },
            { text: "capabilities", link: "/stdlib/capabilities" },
            { text: "clipboard", link: "/stdlib/clipboard" },
            { text: "concurrency", link: "/stdlib/concurrency" },
            { text: "date", link: "/stdlib/date" },
            { text: "fs", link: "/stdlib/fs" },
            { text: "http", link: "/stdlib/http" },
            { text: "image", link: "/stdlib/image" },
            { text: "index", link: "/stdlib/index" },
            { text: "llm", link: "/stdlib/llm" },
            { text: "markdown", link: "/stdlib/markdown" },
            { text: "math", link: "/stdlib/math" },
            { text: "memory", link: "/stdlib/memory" },
            {
              text: "messaging",
              collapsed: false,
              items: [
                { text: "messaging/email", link: "/stdlib/messaging/email" },
                {
                  text: "messaging/imessage",
                  link: "/stdlib/messaging/imessage",
                },
                { text: "messaging/sms", link: "/stdlib/messaging/sms" },
              ],
            },
            { text: "object", link: "/stdlib/object" },
            { text: "path", link: "/stdlib/path" },
            { text: "policy", link: "/stdlib/policy" },
            { text: "shell", link: "/stdlib/shell" },
            { text: "skills", link: "/stdlib/skills" },
            { text: "speech", link: "/stdlib/speech" },
            { text: "statelog", link: "/stdlib/statelog" },
            { text: "strategy", link: "/stdlib/strategy" },
            { text: "syntax", link: "/stdlib/syntax" },
            { text: "system", link: "/stdlib/system" },
            { text: "thread", link: "/stdlib/thread" },
            {
              text: "ui",
              collapsed: false,
              items: [
                { text: "ui (interactive)", link: "/stdlib/ui" },
                { text: "ui/chart", link: "/stdlib/ui/chart" },
                { text: "ui/cli", link: "/stdlib/ui/cli" },
                { text: "ui/layout", link: "/stdlib/ui/layout" },
                { text: "ui/table", link: "/stdlib/ui/table" },
              ],
            },
            { text: "validation", link: "/stdlib/validation" },
            { text: "weather", link: "/stdlib/weather" },
            {
              text: "web",
              collapsed: false,
              items: [
                { text: "web/browser", link: "/stdlib/web/browser" },
                { text: "web/search", link: "/stdlib/web/search" },
              ],
            },
            { text: "wikipedia", link: "/stdlib/wikipedia" },
          ],
        },
      ],
      "/packages/": [
        {
          text: "Packages",
          items: [
            { text: "Overview", link: "/packages/" },
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
