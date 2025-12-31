export function escape(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

export function deepCopy<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}
