// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/schedule/service.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `[Unit]
Description=Agency scheduled agent: {{{name:string}}}

[Service]
Type=oneshot
WorkingDirectory={{{agentDir:string}}}
ExecStart=/bin/bash {{{runScriptPath:string}}}
`;

export type TemplateType = {
  name: string;
  agentDir: string;
  runScriptPath: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    