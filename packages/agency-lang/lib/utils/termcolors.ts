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

// Type for the chainable color function
type ColorFunction = ((...args: any[]) => string) & {
  [K in StyleName]: ColorFunction;
};

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
