import { highlight, Theme } from "cli-highlight";
import chalk from "chalk";

// VS Code Dark+ color palette
const blue = chalk.hex("#569CD6");
const yellow = chalk.hex("#DCDCAA");
const teal = chalk.hex("#4EC9B0");
const lightGreen = chalk.hex("#B5CEA8");
const red = chalk.hex("#D16969");
const orange = chalk.hex("#CE9178");
const lightBlue = chalk.hex("#9CDCFE");
const green = chalk.hex("#6A9955");
const darkGreen = chalk.hex("#608B4E");
const gold = chalk.hex("#D7BA7D");
const lightGray = chalk.hex("#D4D4D4");
const magenta = chalk.hex("#C586C0");

// VS Code Dark+ inspired theme
const vscodeDarkTheme: Theme = {
  keyword: blue,
  built_in: yellow,
  type: teal,
  literal: blue,
  number: lightGreen,
  regexp: red,
  string: orange,
  subst: lightBlue,
  symbol: blue,
  class: teal,
  function: yellow,
  title: yellow,
  params: lightBlue,
  comment: green.italic,
  doctag: darkGreen,
  meta: blue,
  "meta-keyword": blue,
  "meta-string": orange,
  section: blue.bold,
  tag: blue,
  name: blue,
  "builtin-name": yellow,
  attr: lightBlue,
  attribute: lightBlue,
  variable: lightBlue,
  bullet: gold,
  code: lightGray,
  emphasis: chalk.italic,
  strong: chalk.bold,
  formula: magenta,
  link: blue.underline,
  quote: darkGreen,
  "selector-tag": gold,
  "selector-id": gold,
  "selector-class": gold,
  "selector-attr": gold,
  "selector-pseudo": gold,
  "template-tag": magenta,
  "template-variable": lightBlue,
  addition: lightGreen,
  deletion: orange,
  default: lightGray,
};

export function syntaxHighlight(code: string, _language: string): string {
  try {
    const language = _language === "agency" ? "ts" : _language;
    const highlightedCode = highlight(code, {
      language,
      ignoreIllegals: true,
      theme: vscodeDarkTheme,
    });
    return highlightedCode;
  } catch (error) {
    console.error(`Error highlighting code: ${error}`);
    return code; // Return unhighlighted code on error
  }
}
