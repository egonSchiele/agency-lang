// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/schedule/runScript.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `#!/bin/bash
set -e
cd "{{{agentDir:string}}}"
{{#hasEnvFile:boolean}}
set -a
. "{{{envFile:string}}}"
set +a
{{/hasEnvFile}}
LOGFILE="{{{logDir:string}}}/$(date +%Y-%m-%dT%H-%M-%S).log"
{{{command:string}}} run "{{{agentFile:string}}}" >> "$LOGFILE" 2>&1

# Rotate: keep last 50 logs
cd "{{{logDir}}}"
ls -t *.log 2>/dev/null | tail -n +51 | xargs rm -f 2>/dev/null || true
`;

export type TemplateType = {
  agentDir: string;
  hasEnvFile: boolean;
  envFile: string;
  logDir: string;
  command: string;
  agentFile: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    