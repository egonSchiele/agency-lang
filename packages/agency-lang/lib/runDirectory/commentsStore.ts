import * as fs from "fs";
import * as os from "os";

import {
  foldComments,
  parseCommentsJsonl,
  type Comment,
  type CommentAuthor,
  type CommentDraft,
  type FoldedComments,
} from "./comments.js";
import { appendCommentRow } from "./mutations.js";

/**
 * The one interface everything goes through to read or write comments, so
 * nothing else knows where they live or how they are written. The viewer,
 * the session commands, and the CLI all take a store and never a path; a
 * test hands the viewer a fake one. The author is fixed when the store is
 * opened, by the CLI, which is what knows who is at the terminal.
 */
export type CommentsStore = {
  path: string;
  read(): FoldedComments;
  add(draft: Omit<CommentDraft, "author">): Comment;
  /** Bytes on disk the last time `read` ran; a poller compares before
   *  re-reading, since the follow tick fires every 250ms. */
  changedSince(): boolean;
};

/** Who is at the terminal, for a store the CLI opens for a person. */
export function humanAuthorAtTerminal(): CommentAuthor {
  return { kind: "human", id: os.userInfo().username };
}

export function openCommentsStore(
  commentsPath: string,
  author: CommentAuthor,
  reportWarning: (message: string) => void = () => {},
): CommentsStore {
  let lastSize = -1;
  const sizeNow = (): number => {
    try {
      return fs.statSync(commentsPath).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  };
  return {
    path: commentsPath,
    read: () => {
      lastSize = sizeNow();
      if (!fs.existsSync(commentsPath)) {
        return foldComments([]);
      }
      const parsed = parseCommentsJsonl(fs.readFileSync(commentsPath, "utf8"));
      for (const error of parsed.errors) {
        reportWarning(`${commentsPath}:${error.line}: skipping ${error.detail}`);
      }
      return foldComments(parsed.rows);
    },
    add: (draft) => appendCommentRow(commentsPath, { ...draft, author }, { reportWarning }),
    changedSince: () => sizeNow() !== lastSize,
  };
}
