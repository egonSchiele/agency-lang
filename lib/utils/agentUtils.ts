import { highlight } from "cli-highlight";

export function syntaxHighlight(code: string, _language: string): string {
  try {
    const language = _language === "agency" ? "ts" : _language;
    const highlightedCode = highlight(code, { language });
    return highlightedCode;
  } catch (error) {
    console.error(`Error highlighting code: ${error}`);
    return code; // Return unhighlighted code on error
  }
}
