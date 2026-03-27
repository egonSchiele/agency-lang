import fs from "fs";
import path from "path";

export type ToolRegistryEntry = {
  definition: { name: string; description: string; schema: any };
  handler: { name: string; params: string[]; execute: Function; isBuiltin: boolean };
};

export function tool(name: string, registry: Record<string, ToolRegistryEntry>): ToolRegistryEntry {
  if (!registry[name]) throw new Error(`Unknown tool: ${name}`);
  return registry[name];
}

export const not = (val: any): boolean => !val;
export const eq = (a: any, b: any): boolean => a === b;
export const neq = (a: any, b: any): boolean => a !== b;
export const lt = (a: any, b: any): boolean => a < b;
export const lte = (a: any, b: any): boolean => a <= b;
export const gt = (a: any, b: any): boolean => a > b;
export const gte = (a: any, b: any): boolean => a >= b;
export const and = (a: any, b: any): any => a && b;
export const or = (a: any, b: any): any => a || b;
export const head = (arr: any[]): any => arr[0];
export const tail = (arr: any[]): any[] => arr.slice(1);
export const empty = (arr: any[]): boolean => arr.length === 0;

export function builtinRead(args: { filename: string; dirname: string }): string {
  const filePath = path.resolve(args.dirname, args.filename);
  const data = fs.readFileSync(filePath);
  const contents = data.toString("utf8");
  return contents;
}

export function builtinWrite(args: { filename: string; content: string; dirname: string }): boolean {
  const filePath = path.resolve(args.dirname, args.filename);
  fs.writeFileSync(filePath, args.content, "utf8");
  return true;
}

export function builtinReadImage(args: { filename: string; dirname: string }): string {
  const filePath = path.resolve(args.dirname, args.filename);
  const data = fs.readFileSync(filePath);
  const base64String = data.toString("base64");
  return base64String;
}

export function builtinSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

export function readSkill(args: { filepath: string; dirname: string }): string {
  return builtinRead({ filename: args.filepath, dirname: args.dirname });
}
