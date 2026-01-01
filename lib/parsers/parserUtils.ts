import { char, optional } from "tarsec";

export const optionalSemicolon = optional(char(";"));
