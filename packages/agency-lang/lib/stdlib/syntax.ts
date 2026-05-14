import { highlight, Theme } from "cli-highlight";
import { color } from "@/utils/termcolors.js";

// VS Code Dark+ color palette
const blue = color.hex("#569CD6");
const yellow = color.hex("#DCDCAA");
const teal = color.hex("#4EC9B0");
const lightGreen = color.hex("#B5CEA8");
const red = color.hex("#D16969");
const orange = color.hex("#CE9178");
const lightBlue = color.hex("#9CDCFE");
const green = color.hex("#6A9955");
const darkGreen = color.hex("#608B4E");
const gold = color.hex("#D7BA7D");
const lightGray = color.hex("#D4D4D4");
const magenta = color.hex("#C586C0");

// VS Code Dark+ inspired theme. The Theme type expects ChalkInstance
// values; our termcolors functions have a compatible call signature, so
// the cast is safe at runtime — cli-highlight only ever invokes these as
// `(text) => styledText`.
const vscodeDarkTheme = {
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
  emphasis: color.italic,
  strong: color.bold,
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
} as unknown as Theme;

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
