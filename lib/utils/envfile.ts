// parse .env file if it exists into process.env
import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { color } from "termcolors";
export const __dirname = import.meta.dirname;
export const rootDir = join(__dirname, "../../");

export function loadEnv() {
  const envfiles = [
    resolve(rootDir, "..", ".env.local"),
    resolve(rootDir, "..", ".env"),
  ];
  for (const envfile of envfiles) {
    if (tryEnvFile(envfile)) {
      break;
    }
  }
}

function tryEnvFile(envfile: string) {
  if (existsSync(envfile)) {
    const env = readFileSync(envfile, "utf-8");
    env.split("\n").forEach((line) => {
      if (line.trim() === "" || line.startsWith("#")) return;
      const [key, value] = line.split("=");
      process.env[key] = value;
      // console.log("Setting", color.yellow(key), "to", color.yellow(value));
    });
    return true;
  }
  return false;
}
