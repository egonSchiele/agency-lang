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

const FIELD_BOUNDS: [number, number][] = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 7],   // day of week (0 and 7 both mean Sunday)
];

export function validateCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const fieldPattern =
    /^(\*(\/([0-9]+))?|[0-9]+(-[0-9]+)?(\/[0-9]+)?)(,(\*(\/([0-9]+))?|[0-9]+(-[0-9]+)?(\/[0-9]+)?))*$/;
  return fields.every((f, i) => {
    if (!fieldPattern.test(f)) return false;
    // Check bounds and reject step of 0
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

export function nextRun(cronExpr: string): Date {
  const [minF, hourF, domF, monF, dowF] = cronExpr.trim().split(/\s+/);
  // Normalize DOW field: replace 7 with 0 (both mean Sunday, but Date.getDay() returns 0-6)
  const normalizedDowF = dowF.replace(/7/g, "0");
  const candidate = new Date();
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 527_040; i++) {
    if (
      matchField(minF, candidate.getMinutes()) &&
      matchField(hourF, candidate.getHours()) &&
      matchField(domF, candidate.getDate()) &&
      matchField(monF, candidate.getMonth() + 1) &&
      matchField(normalizedDowF, candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return candidate;
}

// Index 7 duplicates "Sun" because cron allows both 0 and 7 to mean Sunday
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function cronToOnCalendar(cron: string): string {
  const [min, hour, dom, mon, dow] = cron.split(/\s+/);

  const dowPart = dow === "*" ? "" : expandDow(dow);
  const datePart = `*-${field(mon)}-${field(dom)}`;
  const timePart = `${field(hour)}:${field(min)}:00`;

  return dowPart ? `${dowPart} ${datePart} ${timePart}` : `${datePart} ${timePart}`;
}

function expandDow(dow: string): string {
  if (dow.includes("-")) {
    const [lo, hi] = dow.split("-").map(Number);
    const days = [];
    for (let i = lo; i <= hi; i++) days.push(DOW_NAMES[i]);
    return days.join(",");
  }
  return DOW_NAMES[Number(dow)] || dow;
}

function field(f: string): string {
  if (f === "*") return "*";
  // Handle step expressions like */15 → *:00/15 is not valid for systemd;
  // systemd uses the same */N syntax for time fields
  if (f.includes("/")) return f;
  if (f.includes("-") || f.includes(",")) return f;
  return f.padStart(2, "0");
}

function matchField(field: string, value: number): boolean {
  return field.split(",").some((part) => matchPart(part, value));
}

function matchPart(part: string, value: number): boolean {
  const [range, stepStr] = part.split("/");
  const step = stepStr ? parseInt(stepStr, 10) : 1;

  if (range === "*") return value % step === 0;

  if (range.includes("-")) {
    const [low, high] = range.split("-").map(Number);
    return value >= low && value <= high && (value - low) % step === 0;
  }

  return parseInt(range, 10) === value;
}
