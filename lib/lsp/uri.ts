import { fileURLToPath, pathToFileURL } from "url";

export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

export function pathToUri(fsPath: string): string {
  return pathToFileURL(fsPath).href;
}
