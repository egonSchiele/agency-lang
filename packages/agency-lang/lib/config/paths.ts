import { z } from "zod";

// A config path is dotted keys, where `*` matches any one key:
// "mcpServers.*.env.*". Merge rules and secret masking are lists of these.

const WILDCARD = "*";

export function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function matchesConfigPath(pattern: string, keys: string[]): boolean {
  const parts = pattern.split(".");
  const sameLength = parts.length === keys.length;
  return sameLength && parts.every((part, index) => part === WILDCARD || part === keys[index]);
}

function mapAt(
  value: unknown,
  patterns: string[],
  transform: (value: unknown) => unknown,
  keys: string[],
): unknown {
  const matched = keys.length > 0 && patterns.some((pattern) => matchesConfigPath(pattern, keys));
  if (matched) {
    return transform(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => mapAt(item, patterns, transform, [...keys, String(index)]));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const entries = Object.entries(value).map(([key, child]) => [
    key,
    mapAt(child, patterns, transform, [...keys, key]),
  ]);
  return Object.fromEntries(entries);
}

/** A copy of `value` with `transform` applied to every value at a matching path. */
export function mapConfigValues(
  value: unknown,
  patterns: string[],
  transform: (value: unknown) => unknown,
): unknown {
  return mapAt(value, patterns, transform, []);
}

function schemaAt(schema: z.ZodType, parts: string[]): z.ZodType | undefined {
  if (parts.length === 0) {
    return schema;
  }
  if (schema instanceof z.ZodOptional) {
    return schemaAt(schema.unwrap() as z.ZodType, parts);
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options as z.ZodType[];
    return options.map((option) => schemaAt(option, parts)).find((found) => found !== undefined);
  }
  const [part, ...rest] = parts;
  if (schema instanceof z.ZodRecord) {
    return part === WILDCARD ? schemaAt(schema.def.valueType as z.ZodType, rest) : undefined;
  }
  if (schema instanceof z.ZodObject) {
    if (part === WILDCARD) {
      // Any key of a fixed object, such as client.apiKey.*
      return rest.length === 0 ? schema : undefined;
    }
    const child = (schema.shape as Record<string, z.ZodType>)[part];
    return child === undefined ? undefined : schemaAt(child, rest);
  }
  return undefined;
}

/** The schema at `pattern`, or undefined when the schema has no such path. */
export function schemaAtConfigPath(schema: z.ZodType, pattern: string): z.ZodType | undefined {
  return schemaAt(schema, pattern.split("."));
}
