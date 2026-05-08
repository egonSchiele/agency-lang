// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/schedule/plist.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agency.schedule.{{{name:string}}}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>{{{runScriptPath:string}}}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{{{agentDir:string}}}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{{{path:string}}}</string>
    <key>HOME</key>
    <string>{{{home:string}}}</string>
  </dict>
  <key>StartCalendarInterval</key>
{{{intervals:string}}}
  <key>StandardOutPath</key>
  <string>{{{logDir:string}}}/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>{{{logDir:string}}}/launchd-stderr.log</string>
</dict>
</plist>
`;

export type TemplateType = {
  name: string;
  runScriptPath: string;
  agentDir: string;
  path: string;
  home: string;
  intervals: string;
  logDir: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    