import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Agency",
  description: "A language for creating agents.",
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
    ],
    sidebar: [
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
          { text: "Imports and Packages", link: "/guide/imports-and-packages" },
          { text: "Schemas", link: "/guide/schemas" },
          { text: "Classes", link: "/guide/classes" },
          { text: "Checkpointing", link: "/guide/checkpointing" },
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
      {
        text: "Standard Library",
        items: [
          { text: "agent", link: "/stdlib/agent" },
          { text: "array", link: "/stdlib/array" },
          { text: "clipboard", link: "/stdlib/clipboard" },
          { text: "fs", link: "/stdlib/fs" },
          { text: "http", link: "/stdlib/http" },
          { text: "index", link: "/stdlib/index" },
          { text: "math", link: "/stdlib/math" },
          { text: "path", link: "/stdlib/path" },
          { text: "retry", link: "/stdlib/retry" },
          { text: "shell", link: "/stdlib/shell" },
          { text: "speech", link: "/stdlib/speech" },
          { text: "strategy", link: "/stdlib/strategy" },
          { text: "system", link: "/stdlib/system" },
          { text: "ui", link: "/stdlib/ui" },
          { text: "weather", link: "/stdlib/weather" },
          { text: "wikipedia", link: "/stdlib/wikipedia" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/egonSchiele/agency-lang" },
    ],
  },
});
