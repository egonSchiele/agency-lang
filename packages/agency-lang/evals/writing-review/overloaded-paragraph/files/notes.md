## The run directory

The run directory annotations fold, which is applied per-question after the
complete-pass filter (score, checklist, and note annotations — each with
deterministic ids — are folded separately), determines which scores listings
show. A coherent lock-free read snapshot (plus the best-effort `notes.md`
read outside it) is taken by the reader, torn tails being skipped, and the
one-run invariant is enforced by a reader guard and a writer preflight so
that a directory is never shared by two runs, which would corrupt the
statistics that batch summaries (mean, standard error, per-trial cost) are
derived from.
