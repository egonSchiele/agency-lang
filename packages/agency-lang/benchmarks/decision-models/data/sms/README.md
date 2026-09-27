# SMS benchmark data

Source: [UCI SMS Spam Collection](https://archive.ics.uci.edu/dataset/228/sms+spam+collection).
Credit: Almeida, T. & Hidalgo, J. (2011), DOI [10.24432/C5CC84](https://doi.org/10.24432/C5CC84).
UCI lists the dataset under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

- `SMSSpamCollection` and `readme` are the original archive contents.
- `sms.jsonl` contains all 5,574 rows converted by the benchmark importer.
- `sms-unique.jsonl` contains 5,171 distinct message texts. It retains the first occurrence and original row ID. The 403 removed duplicates have no conflicting labels.
- `source.json` records provenance, counts, and checksums.

Each case asks whether one message is unsolicited spam. Spam maps to true and ham to false. Message text is preserved. Use the unique file for the first comparison, with the same limit and seed for each backend. Keep the evaluation sample fixed and do not tune prompts against it.

This is an old public dataset, so the models may have encountered it during training. It is a useful initial test, and should be followed with recent examples from the intended application. It tests binary classification; it does not exercise ordinal scores or multiple questions per state. Read macro-F1 and the spam confusion counts alongside accuracy because ham is the majority class.
