// --- Presets ---

export const PRESETS: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekdays: "0 9 * * 1-5",
  weekly: "0 9 * * 1",
};

export function presetToCron(preset: string): string {
  const cron = PRESETS[preset];
  if (!cron) {
    throw new Error(
      `Unknown preset "${preset}". Valid presets: ${Object.keys(PRESETS).join(", ")}`,
    );
  }
  return cron;
}

// --- Cron validation ---

const FIELD_BOUNDS: [number, number][] = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 7],   // day of week (0 and 7 both mean Sunday)
];

const FIELD_PATTERN =
  /^(\*(\/([0-9]+))?|[0-9]+(-[0-9]+)?(\/[0-9]+)?)(,(\*(\/([0-9]+))?|[0-9]+(-[0-9]+)?(\/[0-9]+)?))*$/;

export function validateCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => {
    if (!FIELD_PATTERN.test(f)) return false;
    const [min, max] = FIELD_BOUNDS[i];
    for (const part of f.split(",")) {
      const [range, stepStr] = part.split("/");
      if (stepStr && parseInt(stepStr, 10) === 0) return false;
      if (range !== "*") {
        const nums = range.split("-").map(Number);
        if (nums.some((n) => n < min || n > max)) return false;
      }
    }
    return true;
  });
}

// --- Resolution ---

export function resolveCron(opts: {
  every?: string;
  cron?: string;
}): { cron: string; preset: string } {
  if (opts.every) {
    return { cron: presetToCron(opts.every), preset: opts.every };
  }
  if (opts.cron) {
    if (!validateCron(opts.cron)) {
      throw new Error(
        `Invalid cron expression "${opts.cron}". Expected 5 fields: minute hour day-of-month month day-of-week. Example: "0 9 * * 1-5" (weekdays at 9am)`,
      );
    }
    return { cron: opts.cron, preset: "" };
  }
  throw new Error("Must provide --every or --cron to set a schedule.");
}

export function formatSchedule(cron: string, preset: string): string {
  return preset || cron;
}

// --- Cron to systemd OnCalendar conversion ---

// Index 7 duplicates "Sun" because cron allows both 0 and 7 to mean Sunday
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function passThrough(f: string): string {
  if (f === "*") return "*";
  if (f.includes("/") || f.includes("-") || f.includes(",")) return f;
  return f.padStart(2, "0");
}

function expandDow(dow: string): string {
  if (dow === "*") return "";
  if (dow.includes("-")) {
    const [lo, hi] = dow.split("-").map(Number);
    return Array.from({ length: hi - lo + 1 }, (_, i) => DOW_NAMES[lo + i]).join(",");
  }
  return DOW_NAMES[Number(dow)] || dow;
}

export function cronToOnCalendar(cron: string): string {
  const fields = cron.split(/\s+/);
  const dow = expandDow(fields[4]);
  const calendar = `*-${passThrough(fields[3])}-${passThrough(fields[2])} ${passThrough(fields[1])}:${passThrough(fields[0])}:00`;
  return dow ? `${dow} ${calendar}` : calendar;
}
