# Finding the identifier before you query

Every connector here takes an exact identifier, and a wrong identifier
returns a real answer to the wrong question rather than an error. That is
the failure this skill exists to prevent.

- **FRED** wants a series ID such as `UNRATE` or `GDPC1`. Search for the
  series by description first, then confirm the ID with `fredSeriesInfo`,
  which also reports the units and whether the series is seasonally
  adjusted. `UNRATE` and `UNRATENSA` are different series.
- **EDGAR** wants a CIK, a zero-padded number identifying a filer. Look it
  up from the company name before calling `edgarFilingsByCik`. A parent
  company and its subsidiaries have different CIKs, and an acquired company
  keeps filing under its old CIK for a while.
- **Wikidata** wants a Q-number such as `Q42`. `wikidataSearch` maps a label
  to candidates, and labels are ambiguous: several people and a film may
  share one. Read the description before committing to a candidate.
- **DBnomics** wants provider, dataset, and series together as a path. The
  provider code is not guessable from the country or agency name, so list
  the provider's datasets first.
- **USAspending** identifies awards by an award ID whose format differs
  between contracts and grants.

When a search returns several plausible candidates, say which one you chose
and why, rather than picking silently. When it returns none, say so rather
than substituting a series that looks close.
