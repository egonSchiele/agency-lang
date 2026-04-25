export function canonicalize(value: any): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object") {
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}
