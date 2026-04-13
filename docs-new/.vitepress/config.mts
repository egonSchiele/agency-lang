import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Agency",
  description: "A domain-specific language for defining AI agent workflows",
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
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/your-org/agency-lang" },
    ],
  },
});
