import DefaultTheme from "vitepress/theme";
import "./custom.css";
import HeroWithCode from "./HeroWithCode.vue";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("HeroWithCode", HeroWithCode);
  },
};
