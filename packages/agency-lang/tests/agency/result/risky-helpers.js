export function riskyDouble(x) {
  if (x < 0) {
    throw new Error("negative number");
  }
  return x * 2;
}
