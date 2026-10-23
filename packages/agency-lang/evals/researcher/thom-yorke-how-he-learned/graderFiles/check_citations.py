"""Fetch every URL the answer cites and fail on any that does not exist.

The answer is in the file $AGENCY_OUTPUT names. A URL that does not exist is
an invented citation: a host that does not resolve, or a page that answers
404 or 410. A page that answers 403, 429, or a server error, or that times
out, may be real and blocking scripts, so it is reported as unchecked and
does not fail the grader. An answer that cites no URL fails.
"""

import os
import re
import sys
import urllib.error
import urllib.request

URL_PATTERN = re.compile(r"https?://[^\s)\]>\"']+")
TIMEOUT_SECONDS = 15
MISSING_STATUSES = (404, 410)


def cited_urls(answer):
    seen = []
    for match in URL_PATTERN.findall(answer):
        url = match.rstrip(".,;:")
        if url not in seen:
            seen.append(url)
    return seen


def check(url):
    """Return ("ok" | "missing" | "unchecked", note)."""
    request = urllib.request.Request(url, headers={"User-Agent": "agency-eval-citation-check"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return ("ok", "HTTP %d" % response.status)
    except urllib.error.HTTPError as error:
        if error.code in MISSING_STATUSES:
            return ("missing", "HTTP %d" % error.code)
        return ("unchecked", "HTTP %d" % error.code)
    except urllib.error.URLError as error:
        reason = str(error.reason)
        if "nodename nor servname" in reason or "Name or service not known" in reason:
            return ("missing", "host does not resolve")
        return ("unchecked", reason)
    except Exception as error:  # a timeout or a TLS failure
        return ("unchecked", str(error))


def main():
    with open(os.environ["AGENCY_OUTPUT"], encoding="utf-8") as handle:
        answer = handle.read()
    urls = cited_urls(answer)
    if not urls:
        print("the answer cites no URL")
        return 1
    missing = 0
    for url in urls:
        verdict, note = check(url)
        print("%s %s (%s)" % (verdict.upper().ljust(9), url, note))
        if verdict == "missing":
            missing += 1
    print("%d cited, %d missing" % (len(urls), missing))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
