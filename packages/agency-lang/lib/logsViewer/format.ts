// Number formats shared by every screen. Durations stay in spanText.ts.
export function fmtTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 10_000) {
    return `${Math.round(count / 1000)}k`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

export function fmtUsd(usd: number): string {
  if (usd === 0) {
    return "";
  }
  if (usd >= 1) {
    return `$${usd.toFixed(2)}`;
  }
  if (usd >= 0.01) {
    return `$${usd.toFixed(3)}`;
  }
  return `$${usd.toFixed(4)}`;
}

/** Full local date and 12-hour time, with aligned days and hours for tables. */
export function fmtStartedAt(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = String(date.getDate()).padStart(2);
  const hour = String(date.getHours() % 12 || 12).padStart(2);
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const period = date.getHours() < 12 ? "AM" : "PM";
  return `${month} ${day}, ${date.getFullYear()}  ${hour}:${minute}:${second} ${period}`;
}
