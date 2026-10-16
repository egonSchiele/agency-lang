let bumps = 0;
export function bump() {
  bumps = bumps + 1;
  return bumps;
}
export function bumpCount() {
  return bumps;
}
export function reset() {
  bumps = 0;
}

// A checkpoint a tool took, kept for the node body to restore to.
let kept = null;
export function keep(checkpoint) {
  kept = checkpoint;
  return "kept";
}
export function keptCheckpoint() {
  return kept;
}
