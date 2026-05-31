let __count = 0;
export function bump() {
  __count++;
  return __count;
}
export function read() {
  return __count;
}
