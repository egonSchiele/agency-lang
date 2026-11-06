/** The environment variables that change what a `git` command does. The
 *  git tools remove all three lists before they run git
 *  (`lib/stdlib/gitCore.ts`). A shell script loses the first two
 *  (`lib/host/node/nodeSubprocess.ts`). Both read these lists, so the two
 *  cannot drift apart. A trailing `*` matches every name with that prefix. */

/** Point git at another repository, index, or object store. With one set,
 *  a git command acts somewhere other than its working directory. */
export const GIT_RETARGET_ENV: string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
];

/** Name a program git runs, or config git loads. */
export const GIT_CODE_ENV: string[] = [
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EXEC_PATH",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ATTR_SOURCE",
  // GIT_CONFIG, GIT_CONFIG_GLOBAL/SYSTEM, GIT_CONFIG_COUNT/KEY_n/VALUE_n
  "GIT_CONFIG*",
];

/** Name the program git connects with. Kept apart because a person may set
 *  one on purpose, so that `git push` uses a particular key. The git tools
 *  remove these too. A shell script keeps them. */
export const GIT_SSH_ENV: string[] = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_PROXY_COMMAND"];

/** True when `key` is named by a list, exactly or by a `*` prefix. */
export function namedBy(rules: string[], key: string): boolean {
  return rules.some((rule) =>
    rule.endsWith("*") ? key.startsWith(rule.slice(0, -1)) : key === rule,
  );
}
