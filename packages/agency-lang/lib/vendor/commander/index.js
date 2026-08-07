import { Argument } from './argument.js';
import { Command } from './command.js';
import { CommanderError, InvalidArgumentError } from './error.js';
import { Help } from './help.js';
import { Option } from './option.js';

export const program = new Command();

export const createCommand = (name) => new Command(name);
export const createOption = (flags, description) =>
  new Option(flags, description);
export const createArgument = (name, description) =>
  new Argument(name, description);

/**
 * Expose classes
 */

export { Command, Option, Argument, Help };
export { CommanderError, InvalidArgumentError };
export { InvalidArgumentError as InvalidOptionArgumentError }; // Deprecated
