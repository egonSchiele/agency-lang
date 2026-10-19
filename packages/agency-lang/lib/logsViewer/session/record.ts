// What a running viewer writes about itself so the CLI can find it. The
// comments path is here because the CLI cannot tell from a statelog path
// alone whether comments live in a run directory or in a sidecar.
import { z } from "zod";

export const SessionRecordSchema = z
  .object({
    pid: z.number().int().positive(),
    logPath: z.string().min(1),
    /** Absent when the viewer has no comments store. */
    commentsPath: z.string().min(1).optional(),
    cwd: z.string(),
    started: z.string(),
  })
  .strict();

export type SessionRecord = z.infer<typeof SessionRecordSchema>;
