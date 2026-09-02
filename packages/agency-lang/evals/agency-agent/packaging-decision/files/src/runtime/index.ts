// The public runtime API — the surface compiled programs (and the agent)
// import. Everything else under src/runtime/ is internal.
export { saveCheckpoint, resumeCheckpoint } from "./checkpoint.js";

export async function runProgram(entry: string, args: string[]): Promise<void> {
  const mod = await import(entry);
  await mod.main(args);
}
