let bumps = 0;
export function bump() {
  bumps = bumps + 1;
  return bumps;
}
export function bumpCount() {
  return bumps;
}
