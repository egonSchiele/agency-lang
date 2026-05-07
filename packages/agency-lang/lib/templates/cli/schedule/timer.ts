// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/schedule/timer.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `[Unit]
Description=Timer for agency-schedule-{{{name:string}}}

[Timer]
OnCalendar={{{onCalendar:string}}}
Persistent=true

[Install]
WantedBy=timers.target
`;

export type TemplateType = {
  name: string;
  onCalendar: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    