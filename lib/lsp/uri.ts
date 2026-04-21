import { URL } from "url";

export function uriToPath(uri: string): string {
  return new URL(uri).pathname;
}

export function pathToUri(fsPath: string): string {
  return `file://${fsPath}`;
}
