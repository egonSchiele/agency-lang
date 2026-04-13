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
        text: "Features",
        items: [
          { text: "Intro", link: "/features/intro" },
          { text: "Interrupts", link: "/features/interrupts" },
          { text: "Debugging", link: "/features/debugging" },
          { text: "Error Handling", link: "/features/error-handling" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/egonSchiele/agency-lang" },
    ],
  },
});
