## The run directory

Listings show one score per question. Scores come from grading passes
recorded in the directory, and only a pass that finished completely
counts. When several complete passes scored the same question, the most
recent one wins.

Reading the directory never takes a lock. A reader takes a snapshot and
skips any half-written trailing line, so what it returns is always
coherent. One directory belongs to one run: both the reader and the
writer check this, because two runs sharing a directory would corrupt
the statistics computed over it.
