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
        ],
      },
      {
        text: "Use Cases",
        items: [
          { text: "Intro", link: "/use-cases/intro" },
          { text: "Interrupts", link: "/use-cases/interrupts" },
          { text: "Debugging", link: "/use-cases/debugging" },
          { text: "Error Handling", link: "/use-cases/error-handling" },
        ],
      },
      {
        text: "The Book",
        items: [{ text: "The Agency Book", link: "/book/index" }],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/egonSchiele/agency-lang" },
    ],
  },
});
