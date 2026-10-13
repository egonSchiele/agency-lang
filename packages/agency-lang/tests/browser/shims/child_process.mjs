// For the browser bundle check: tarsec imports `execSync` at load and calls
// it only when tracing to a server, which the browser never does.
export function execSync() {
  throw new Error("child_process is not available in a browser");
}
