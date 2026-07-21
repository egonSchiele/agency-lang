import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Agency",
  description: "A language for creating agents.",
  themeConfig: {
    outline: "deep",
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Agent", link: "/agent/index" },
      { text: "CLI", link: "/cli/index" },
      { text: "Standard Library", link: "/stdlib/index" },
      { text: "Packages", link: "/packages/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "00. Why Agency?",
          items: [{ text: "Why Agency?", link: "/guide/why-agency" }],
        },
        {
          text: "01. Basics",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Basic Syntax", link: "/guide/basic-syntax" },
            { text: "Types", link: "/guide/types" },
            { text: "Nodes", link: "/guide/nodes" },

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
            { text: "List Comprehensions", link: "/guide/comprehensions" },
            { text: "Pattern Matching", link: "/guide/pattern-matching" },
            { text: "Concurrency", link: "/guide/concurrency" },
            {
              text: "Interrupts from TypeScript",
              link: "/guide/interrupts-from-typescript",
            },
            {
              text: "Agency's Standard Library",
              link: "/guide/agency-stdlib",
            },
          ],
        },
        {
          text: "04. Tooling",
          items: [
            {
              text: "Compiling and Running Code",
              link: "/guide/compiling-and-running",
            },
            { text: "Agency Config File", link: "/guide/agency-config-file" },
            { text: "Testing", link: "/guide/testing" },
          ],
        },
        {
          text: "05. LLMs",
          items: [
            {
              text: "LLM Calls, Part 2",
              link: "/guide/llm-part-2",
            },
            {
              text: "Streaming",
              link: "/guide/streaming",
            },
            {
              text: "Message Threads",
              link: "/guide/message-threads",
            },

            { text: "Attachments", link: "/guide/attachments" },
            { text: "Image generation", link: "/guide/image-generation" },
            { text: "Guards", link: "/guide/guards" },
          ],
        },
        {
          text: "06. Agency's Execution Model",
          items: [
            { text: "Checkpointing", link: "/guide/checkpointing" },
            { text: "Interrupts, Part 2", link: "/guide/interrupts-part-2" },
            { text: "State Isolation", link: "/guide/state-isolation" },
            {
              text: "Global vs Static Variables",
              link: "/guide/global-vs-static",
            },

            {
              text: "Global Variable Initialization",
              link: "/guide/global-var-initialization",
            },
          ],
        },
        {
          text: "07. Tooling, Part 2",
          items: [
            { text: "Developer Tools", link: "/guide/developer-tools" },
            { text: "Debugging", link: "/guide/debugging" },
            { text: "Observability", link: "/guide/observability" },
          ],
        },

        {
          text: "08. Safety, Part 2",
          items: [
            {
              text: "Effect Sets and raises",
              link: "/guide/effects-and-raises",
            },
            { text: "Policies", link: "/guide/policies" },
          ],
        },
        {
          text: "09. Advanced",
          items: [
            { text: "Callbacks", link: "/guide/callbacks" },
            { text: "Partial Results", link: "/guide/partial-results" },
            {
              text: "Agency Packages",
              link: "/guide/agency-packages",
            },

            { text: "Schemas", link: "/guide/schemas" },
            { text: "Type Validation", link: "/guide/type-validation" },
            {
              text: "Value-Parameterized Types",
              link: "/guide/value-parameterized-types",
            },
            { text: "Memory", link: "/guide/memory" },
            { text: "Tags and Redaction", link: "/guide/tags" },
          ],
        },
        {
          text: "Appendix",
          collapsed: true,
          items: [
            { text: "VSCode Extension", link: "/guide/vscode-extension" },
            {
              text: "Agency vs TypeScript",
              link: "/guide/agency-vs-typescript",
            },
            {
              text: "Built-in Functions",
              link: "/guide/builtins",
            },
            {
              text: "Notes on Types",
              link: "/guide/notes-on-types",
            },
            {
              text: "TypeScript Helpers (agency.*)",
              link: "/guide/ts-helpers",
            },
            {
              text: "Schema Parameter Injection",
              link: "/guide/schema-parameter-injection",
            },
            { text: "MCP", link: "/guide/mcp" },
            { text: "Serving Agency Code", link: "/guide/serving" },
            { text: "Build Integration", link: "/guide/build-integration" },
            {
              text: "Custom Providers",
              link: "/guide/custom-providers",
            },
            {
              text: "Cross-Thread Context Sharing",
              link: "/guide/cross-thread-context",
            },
          ],
        },
      ],
      "/agent/": [
        {
          text: "Agent",
          items: [
            { text: "Overview", link: "/agent/index" },
            { text: "Models and settings", link: "/agent/models" },
            { text: "Memory", link: "/agent/memory" },
            { text: "Project context and commands", link: "/agent/project-context" },
            { text: "MCP servers", link: "/agent/mcp" },
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
            {
              text: "agents",
              collapsed: true,
              items: [
                { text: "agents/coding", link: "/stdlib/agents/coding" },
                { text: "agents/data", link: "/stdlib/agents/data" },
                { text: "agents/expert", link: "/stdlib/agents/expert" },
                { text: "agents/explorer", link: "/stdlib/agents/explorer" },
                { text: "agents/oracle", link: "/stdlib/agents/oracle" },
                { text: "agents/planner", link: "/stdlib/agents/planner" },
                { text: "agents/researcher", link: "/stdlib/agents/researcher" },
                { text: "agents/review", link: "/stdlib/agents/review" },
                { text: "agents/verifier", link: "/stdlib/agents/verifier" },
                {
                  text: "agents/agency/coding",
                  link: "/stdlib/agents/agency/coding",
                },
                {
                  text: "agents/agency/expert",
                  link: "/stdlib/agents/agency/expert",
                },
                {
                  text: "agents/agency/researcher",
                  link: "/stdlib/agents/agency/researcher",
                },
                {
                  text: "agents/agency/review",
                  link: "/stdlib/agents/agency/review",
                },
                {
                  text: "agents/agency/verifier",
                  link: "/stdlib/agents/agency/verifier",
                },
                {
                  text: "agents/lib/expertGuidance",
                  link: "/stdlib/agents/lib/expertGuidance",
                },
                {
                  text: "agents/lib/feedback",
                  link: "/stdlib/agents/lib/feedback",
                },
                { text: "agents/lib/search", link: "/stdlib/agents/lib/search" },
                { text: "agents/lib/shared", link: "/stdlib/agents/lib/shared" },
                {
                  text: "agents/lib/toolkits",
                  link: "/stdlib/agents/lib/toolkits",
                },
              ],
            },
            { text: "args", link: "/stdlib/args" },
            { text: "array", link: "/stdlib/array" },
            {
              text: "auth",
              collapsed: true,
              items: [
                { text: "auth/keyring", link: "/stdlib/auth/keyring" },
                { text: "auth/oauth", link: "/stdlib/auth/oauth" },
              ],
            },
            { text: "calendar", link: "/stdlib/calendar" },
            { text: "capabilities", link: "/stdlib/capabilities" },
            { text: "clipboard", link: "/stdlib/clipboard" },
            { text: "concurrency", link: "/stdlib/concurrency" },
            {
              text: "data",
              collapsed: true,
              items: [
                { text: "data/finance/gdelt", link: "/stdlib/data/finance/gdelt" },
                { text: "data/finance/fred", link: "/stdlib/data/finance/fred" },
                { text: "data/finance/edgar", link: "/stdlib/data/finance/edgar" },
                {
                  text: "data/finance/dbnomics",
                  link: "/stdlib/data/finance/dbnomics",
                },
                {
                  text: "data/people/littlesis",
                  link: "/stdlib/data/people/littlesis",
                },
                {
                  text: "data/tech/yc",
                  link: "/stdlib/data/tech/yc",
                },
                {
                  text: "data/tech/hackernews",
                  link: "/stdlib/data/tech/hackernews",
                },
                {
                  text: "data/wikidata",
                  link: "/stdlib/data/wikidata",
                },
                {
                  text: "data/usaspending",
                  link: "/stdlib/data/usaspending",
                },
              ],
            },
            { text: "date", link: "/stdlib/date" },
            { text: "fs", link: "/stdlib/fs" },
            { text: "http", link: "/stdlib/http" },
            { text: "image", link: "/stdlib/image" },
            { text: "index", link: "/stdlib/index" },
            { text: "llm", link: "/stdlib/llm" },
            { text: "markdown", link: "/stdlib/markdown" },
            { text: "math", link: "/stdlib/math" },
            { text: "mcp", link: "/stdlib/mcp" },
            { text: "memory", link: "/stdlib/memory" },
            {
              text: "messaging",
              collapsed: true,
              items: [
                { text: "messaging/email", link: "/stdlib/messaging/email" },
                {
                  text: "messaging/imessage",
                  link: "/stdlib/messaging/imessage",
                },
                { text: "messaging/sms", link: "/stdlib/messaging/sms" },
              ],
            },
            {
              text: "notes",
              collapsed: true,
              items: [
                { text: "notes/apple", link: "/stdlib/notes/apple" },
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
            { text: "supervise", link: "/stdlib/supervise" },
            { text: "syntax", link: "/stdlib/syntax" },
            { text: "system", link: "/stdlib/system" },
            { text: "thread", link: "/stdlib/thread" },
            {
              text: "ui",
              collapsed: true,
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
              collapsed: true,
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
            { text: "email", link: "/packages/email/" },
            { text: "github", link: "/packages/github/" },
            { text: "mcp", link: "/packages/mcp/" },
            { text: "web-fetch", link: "/packages/web-fetch/" },
            { text: "whisper-local", link: "/packages/whisper-local/" },
          ],
        },
      ],
      "/diagnostics/": [
        {
          text: "Diagnostics",
          items: [
            { text: "Overview", link: "/diagnostics/" },
            { text: "Checking", link: "/diagnostics/checking" },
            { text: "Effects", link: "/diagnostics/effects" },
            { text: "Match", link: "/diagnostics/match" },
            { text: "Names", link: "/diagnostics/names" },
            { text: "Static Init", link: "/diagnostics/static-init" },
            { text: "Tools", link: "/diagnostics/tools" },
            { text: "Types and Aliases", link: "/diagnostics/types-aliases" },

          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/egonSchiele/agency-lang" },
    ],
  },
});
