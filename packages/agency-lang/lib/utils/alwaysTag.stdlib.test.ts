import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseAgency } from "../parser.js";
import { TypescriptPreprocessor } from "../preprocessors/typescriptPreprocessor.js";
import { readAlwaysScope, type AlwaysTagProblem } from "./alwaysTag.js";
import type { ScopedField } from "../runtime/alwaysScope.js";
import type { EffectDeclaration } from "../types/effectDeclaration.js";

const STDLIB = path.resolve(__dirname, "../../stdlib");

function agencyFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return agencyFiles(full);
    }
    return entry.name.endsWith(".agency") ? [full] : [];
  });
}

type Declared = { file: string; effect: string; scope: string[]; problems: AlwaysTagProblem[] };

function effectDeclarations(file: string): EffectDeclaration[] {
  const parsed = parseAgency(fs.readFileSync(file, "utf8"));
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.message}`);
  }
  // attachTags() only, not preprocess(): the full pipeline wants a
  // compilation unit and runs every transform, which stdlib files with
  // splices or templates may not survive standalone.
  new TypescriptPreprocessor(parsed.result).attachTags();
  return parsed.result.nodes.filter(
    (node): node is EffectDeclaration => node.type === "effectDeclaration",
  );
}

function describeField(field: ScopedField): string {
  return field.matchSubpaths ? `${field.field}/**` : field.field;
}

function declared(file: string, decl: EffectDeclaration): Declared {
  const { fields, problems } = readAlwaysScope(decl.tags);
  return { file, effect: decl.effect, scope: fields.map(describeField), problems };
}

/** Every effect declaration in the stdlib, one entry per DECLARATION.
 *  Some effects are declared in two files (`std::read` and `std::write`
 *  in both `stdlib/index.agency` and `stdlib/agency.agency`); keeping
 *  every declaration lets the test check that all copies agree instead
 *  of letting the last file parsed win. */
function stdlibDeclarations(): Declared[] {
  return agencyFiles(STDLIB).flatMap((file) =>
    effectDeclarations(file).map((decl) => declared(file, decl)),
  );
}

// The decision table from the spec (§5.6). Adding an effect to the stdlib
// means adding a row here, so nobody ships an effect without deciding
// what "approve always here" means for it.
const EXPECTED: Record<string, string[]> = {
  "std::read": ["dir/**"],
  "std::readBinary": ["dir/**"],
  "std::readImage": ["dir/**"],
  "std::write": ["dir/**"],
  "std::writeBinary": ["dir/**"],
  "std::edit": ["dir/**"],
  "std::ls": ["dir/**"],
  "std::glob": ["dir/**"],
  "std::grep": ["dir/**"],
  "std::mkdir": ["dir/**"],
  "std::remove": ["target/**"],
  "std::copy": ["src/**", "dest/**"],
  "std::move": ["src/**", "dest/**"],
  "std::applyPatch": [],
  "std::exec": ["command", "subcommand"],
  "std::bash": ["command", "cwd"],
  "std::run": [],
  "std::git::status": ["cwd/**"],
  "std::git::log": ["cwd/**"],
  "std::git::diff": ["cwd/**"],
  "std::git::show": ["cwd/**"],
  "std::git::branchList": ["cwd/**"],
  "std::git::remoteList": ["cwd/**"],
  "std::git::blame": ["cwd/**"],
  "std::git::stashList": ["cwd/**"],
  "std::git::add": ["cwd/**"],
  "std::git::commit": ["cwd/**"],
  "std::git::checkout": ["cwd/**"],
  "std::git::switch": ["cwd/**"],
  "std::git::branchCreate": ["cwd/**"],
  "std::git::branchDelete": ["cwd/**"],
  "std::git::stashPush": ["cwd/**"],
  "std::git::stashPop": ["cwd/**"],
  "std::git::restore": ["cwd/**"],
  "std::env": ["name"],
  "std::setEnv": ["name"],
  "std::getSecret": ["service", "key"],
  "std::setSecret": ["service", "key"],
  "std::deleteSecret": ["service", "key"],
  "std::authorize": ["name"],
  "std::getAccessToken": ["name"],
  "std::revokeAuth": ["name"],
  "std::authorizeCalendar": ["clientId"],
  "std::http::fetch": ["method", "baseUrl"],
  "std::http::fetchJSON": ["method", "baseUrl"],
  "std::http::fetchMarkdown": ["method", "baseUrl"],
  "std::openUrl": ["host"],
  "std::search": [],
  "std::tavilySearch": [],
  "std::wikipedia::search": [],
  "std::wikipedia::summary": [],
  "std::wikipedia::article": [],
  "std::weather": [],
  "std::browserUse": [],
  "std::sendEmail": ["to"],
  "std::sendSms": ["to"],
  "std::sendIMessage": ["to"],
  "std::notify": [],
  "std::say": [],
  "std::synthesizeSpeech": [],
  "std::transcribe": [],
  "std::record": [],
  "std::screenshot": [],
  "std::clipboardCopy": [],
  "std::clipboardPaste": [],
  "mcp::call": ["server", "tool"],
  // GitHub: an "always" answer pins to one repository, never the account.
  "std::github::prList": ["owner", "repo"],
  "std::github::prGet": ["owner", "repo"],
  "std::github::prDiff": ["owner", "repo"],
  "std::github::prFiles": ["owner", "repo"],
  "std::github::prReviewList": ["owner", "repo"],
  "std::github::prReviewCommentList": ["owner", "repo"],
  "std::github::prChecks": ["owner", "repo"],
  "std::github::issueList": ["owner", "repo"],
  "std::github::issueGet": ["owner", "repo"],
  "std::github::issueCommentList": ["owner", "repo"],
  "std::github::issueSearch": ["owner", "repo"],
  "std::github::prReviewComment": ["owner", "repo"],
  "std::github::prReview": ["owner", "repo"],
  "std::github::prApprove": ["owner", "repo"],
  "std::github::issueCreate": ["owner", "repo"],
  "std::github::issueComment": ["owner", "repo"],
  "std::github::issueUpdate": ["owner", "repo"],
  "std::github::issueLabel": ["owner", "repo"],
  "std::skills::skillsDir": ["dir/**"],
  "std::skills::commandsDir": ["dir/**"],
  "std::skills::save": ["dir/**"],
  "std::toolbox::scan": ["dir/**"],
  "std::toolbox::review": [],
  "std::memory::enableMemory": [],
  "std::memory::disableMemory": [],
  "std::memory::remember": [],
  "std::memory::recall": [],
  "std::memory::forget": [],
  "std::listEvents": ["calendarId"],
  // createEvent and updateEvent carry no calendarId in their payload.
  "std::createEvent": [],
  "std::updateEvent": [],
  "std::deleteEvent": ["calendarId"],
  "std::notes::create": ["folder"],
  "std::notes::append": ["folder"],
  "std::notes::read": ["folder"],
  "std::notes::search": ["folder"],
  "std::notes::list": ["folder"],
  "std::notes::delete": ["folder"],
  "std::question": [],
  "std::agents::planApprove": [],
  "std::exit": [],
  // Query-style data connectors and S3: no field worth pinning.
  "std::aws::s3::get": [],
  "std::aws::s3::getBinary": [],
  "std::aws::s3::put": [],
  "std::aws::s3::putBinary": [],
  "std::aws::s3::createBucket": [],
  "std::aws::s3::presignGet": [],
  "std::bluesky": [],
  "std::dbnomics": [],
  "std::edgar": [],
  "std::fred": [],
  "std::gdelt": [],
  "std::hackernews": [],
  "std::littlesis": [],
  "std::usaspending": [],
  "std::wikidata": [],
  "std::yc": [],
};

describe("every stdlib effect has a decided always-scope", () => {
  const declarations = stdlibDeclarations();

  it("has no malformed tags", () => {
    const malformed = declarations.filter((one) => one.problems.length > 0);
    expect(malformed.map((one) => `${one.file} ${one.effect}`)).toEqual([]);
  });

  it("matches the decision table", () => {
    // Effects declared in the stdlib but missing from the table, and rows
    // in the table with no declaration, both fail here.
    const declaredEffects = declarations
      .map((one) => one.effect)
      .filter((effect, index, list) => list.indexOf(effect) === index)
      .sort();
    expect(declaredEffects).toEqual(Object.keys(EXPECTED).sort());
    const wrong = declarations.filter(
      (one) => JSON.stringify(one.scope) !== JSON.stringify(EXPECTED[one.effect]),
    );
    expect(wrong.map((one) => `${one.file} ${one.effect}: ${one.scope.join(",")}`)).toEqual([]);
  });
});
