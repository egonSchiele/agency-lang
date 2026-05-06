export function stripBoundParams(
  description: string,
  boundParamNames: string[]
): string {
  if (!description || boundParamNames.length === 0) return description;

  const lines = description.split("\n");
  const result: string[] = [];
  let stripping = false;

  for (const line of lines) {
    const paramMatch = line.match(/^\s*@param\s+(\w+)/);
    if (paramMatch) {
      if (boundParamNames.includes(paramMatch[1])) {
        stripping = true;
        continue;
      } else {
        stripping = false;
      }
    } else if (stripping) {
      if (line.trim() === "") {
        stripping = false;
        continue;
      }
      continue;
    }
    result.push(line);
  }

  return result.join("\n");
}
