// ANSI escape codes
const RESET = "\x1b[0m";

// Text color codes
const colors = {
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
} as const;

// Background color codes
const bgColors = {
  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgWhite: "\x1b[47m",
  bgBrightBlack: "\x1b[100m",
  bgBrightRed: "\x1b[101m",
  bgBrightGreen: "\x1b[102m",
  bgBrightYellow: "\x1b[103m",
  bgBrightBlue: "\x1b[104m",
  bgBrightMagenta: "\x1b[105m",
  bgBrightCyan: "\x1b[106m",
  bgBrightWhite: "\x1b[107m",
} as const;

// Text modifier codes
const modifiers = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
} as const;

// Combine all style codes
const styles = { ...colors, ...bgColors, ...modifiers } as const;

type StyleName = keyof typeof styles;

// Methods that accept arguments and return a new chainable function.
// Unlike static style names, these need to be invoked with parameters
// (a hex string or RGB triple) before they emit a code.
type ColorMethods = {
  hex(value: string): ColorFunction;
  bgHex(value: string): ColorFunction;
  rgb(r: number, g: number, b: number): ColorFunction;
  bgRgb(r: number, g: number, b: number): ColorFunction;
};

// Type for the chainable color function
type ColorFunction = ((...args: any[]) => string) & {
  [K in StyleName]: ColorFunction;
} & ColorMethods;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function parseHex(value: string): [number, number, number] {
  if (!HEX_RE.test(value)) {
    throw new Error(`Invalid hex color: ${JSON.stringify(value)}. Expected "#rgb" or "#rrggbb".`);
  }
  const h = value.slice(1);
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbCode(r: number, g: number, b: number, kind: "fg" | "bg"): string {
  const introducer = kind === "fg" ? 38 : 48;
  return `\x1b[${introducer};2;${clampByte(r)};${clampByte(g)};${clampByte(b)}m`;
}

/**
 * Creates a chainable color function that accumulates ANSI codes
 */
function createColorFunction(codes: string[] = []): ColorFunction {
  // The function that applies all accumulated codes to text
  const applyColor = (...args: any[]): string => {
    const text = args.join(" ");
    if (codes.length === 0) {
      return text;
    }
    return codes.join("") + text + RESET;
  };

  // Create a proxy to handle property access for chaining
  return new Proxy(applyColor as ColorFunction, {
    get(target, prop: string) {
      if (prop in styles) {
        // Add this style's code and return a new chainable function
        const newCodes = [...codes, styles[prop as StyleName]];
        return createColorFunction(newCodes);
      }
      if (prop === "hex") {
        return (value: string) =>
          createColorFunction([...codes, rgbCode(...parseHex(value), "fg")]);
      }
      if (prop === "bgHex") {
        return (value: string) =>
          createColorFunction([...codes, rgbCode(...parseHex(value), "bg")]);
      }
      if (prop === "rgb") {
        return (r: number, g: number, b: number) =>
          createColorFunction([...codes, rgbCode(r, g, b, "fg")]);
      }
      if (prop === "bgRgb") {
        return (r: number, g: number, b: number) =>
          createColorFunction([...codes, rgbCode(r, g, b, "bg")]);
      }
      return target[prop as keyof typeof target];
    },
  });
}

/**
 * Main color object for terminal text styling
 *
 * @example
 * ```ts
 * import { color } from 'termcolors';
 * console.log(color.blue("this text is blue!"));
 * console.log(color.green.bold("this text is green and bold!"));
 * console.log(color.green.bgYellow("this text is green with a yellow background!"));
 * console.log(color.green("a", "lot", "of", "words!"));
 * ```
 */
export const color = createColorFunction();

/**
 * Creates a chainable function with the same shape as the color function,
 * but emits no ANSI codes. Used by `ttyColor` when stdout is not a TTY.
 */
function createNoopColorFunction(): ColorFunction {
  const applyNoop = (...args: any[]): string => args.join(" ");
  return new Proxy(applyNoop as ColorFunction, {
    get(target, prop: string) {
      if (prop in styles) return createNoopColorFunction();
      if (prop === "hex" || prop === "bgHex") {
        return (_value: string) => createNoopColorFunction();
      }
      if (prop === "rgb" || prop === "bgRgb") {
        return (_r: number, _g: number, _b: number) => createNoopColorFunction();
      }
      return target[prop as keyof typeof target];
    },
  });
}

/**
 * Like `color`, but emits no ANSI codes when stdout is not a TTY (e.g., when
 * output is piped to a file or another process). Use this anywhere you want
 * conditional coloring without manually checking `process.stdout.isTTY`.
 *
 * @example
 * ```ts
 * import { ttyColor } from 'termcolors';
 * console.log(ttyColor.green("colored on a terminal, plain when piped"));
 * ```
 */
export const ttyColor: ColorFunction = process.stdout.isTTY
  ? color
  : createNoopColorFunction();
