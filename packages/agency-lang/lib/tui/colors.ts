export const ansiColors: Record<string, string> = {
  black: "\x1b[30m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[37m",
  gray: "\x1b[90m",
  "bright-red": "\x1b[91m", "bright-green": "\x1b[92m", "bright-yellow": "\x1b[93m",
  "bright-blue": "\x1b[94m", "bright-magenta": "\x1b[95m", "bright-cyan": "\x1b[96m",
  "bright-white": "\x1b[97m",
};

export const ansiBgColors: Record<string, string> = {
  black: "\x1b[40m", red: "\x1b[41m", green: "\x1b[42m", yellow: "\x1b[43m",
  blue: "\x1b[44m", magenta: "\x1b[45m", cyan: "\x1b[46m", white: "\x1b[47m",
  gray: "\x1b[100m",
  "bright-red": "\x1b[101m", "bright-green": "\x1b[102m", "bright-yellow": "\x1b[103m",
  "bright-blue": "\x1b[104m", "bright-magenta": "\x1b[105m", "bright-cyan": "\x1b[106m",
  "bright-white": "\x1b[107m",
};

/**
 * SECURITY: this map plus a strict hex-color regex are the only allowed
 * sources for color values in HTML output. The HTML adapter
 * (`render/html.ts`) MUST only emit a CSS color that is either a value
 * from this object (named colors) or a literal hex string matching
 * `^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`. Any other value (e.g. an
 * attacker-controlled Style.fg/bg/borderColor/labelColor) must be
 * dropped silently. Do not bypass either check.
 */
export const cssColors: Record<string, string> = {
  black: "#000", red: "#c00", green: "#0a0", yellow: "#aa0",
  blue: "#00a", magenta: "#a0a", cyan: "#0aa", white: "#ccc",
  gray: "#888",
  "bright-red": "#f55", "bright-green": "#5f5", "bright-yellow": "#ff5",
  "bright-blue": "#55f", "bright-magenta": "#f5f", "bright-cyan": "#5ff",
  "bright-white": "#fff",
};
