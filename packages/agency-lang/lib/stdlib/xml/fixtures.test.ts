import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseXml } from "./grammar.js";
import { xmlAttr, xmlFind, xmlFindAll, xmlText } from "./helpers.js";
import type { XmlElement } from "./types.js";

const FIXTURE_DIR = join(__dirname, "testFixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function parsedRoot(name: string): XmlElement {
  const r = parseXml(fixture(name));
  if (!r.ok) throw new Error(`fixture ${name} failed to parse: ${r.error}`);
  return r.doc.root;
}

describe("fixture hygiene", () => {
  // Durable sanitizer: no raw NUL/forbidden controls, no Reddit feed-token
  // or user query parameters, no URL-embedded credentials, no bearer
  // headers. Deliberately does NOT ban all `@` — public feeds legitimately
  // contain handles and author emails.
  it("every checked-in fixture is free of controls and credential shapes", () => {
    const names = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".xml"));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      const src = fixture(name);
      expect(src, `${name}: raw control characters`).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
      expect(src, `${name}: reddit feed-token query params`).not.toMatch(/[?&;](feed|user)=/i);
      expect(src, `${name}: credentials in URL userinfo`).not.toMatch(/:\/\/[^/\s"<>]+:[^/\s"<>]+@/);
      expect(src, `${name}: token-ish query params`).not.toMatch(/[?&](api_?key|access_?token|auth|secret|password)=/i);
      expect(src, `${name}: authorization header text`).not.toMatch(/authorization:\s*(bearer|basic)/i);
    }
  });
});

describe("Reddit Atom fixture (r/minnesota hot)", () => {
  it("parses and extracts known values", () => {
    const root = parsedRoot("reddit-minnesota-hot.atom.xml");
    expect(root.tag).toBe("feed");
    expect(xmlText(xmlFind(root, "title"))).toBe("The Front Page of Minnesota, United States (MN)");

    const entries = xmlFindAll(root, "entry");
    expect(entries.length).toBe(10);

    const first = entries[0];
    expect(xmlText(xmlFind(first, "title"))).toBe(
      "/r/Minnesota Monthly FAQ / Moving-to-MN / Simple Questions Thread - August 2026",
    );
    expect(xmlAttr(xmlFind(first, "link"), "href")).toBe(
      "https://www.reddit.com/r/minnesota/comments/1vclj4f/rminnesota_monthly_faq_movingtomn_simple/",
    );
    expect(xmlText(xmlFind(xmlFind(first, "author"), "name"))).toBe("/u/AutoModerator");
    expect(xmlText(xmlFind(first, "published"))).toBe("2026-08-01T12:00:58+00:00");

    // Namespaced names are matched literally.
    const thumbs = xmlFindAll(root, "media:thumbnail");
    expect(thumbs.length).toBeGreaterThan(0);
    expect(xmlAttr(thumbs[0], "url")).toMatch(/^https:\/\//);
  });

  it("parses well under the gross performance bound", () => {
    const src = fixture("reddit-minnesota-hot.atom.xml");
    const t0 = performance.now();
    const r = parseXml(src);
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    if (r.ok) expect(xmlFindAll(r.doc.root, "entry").length).toBe(10);
    // Gross smoke only (a ~30KB feed taking seconds would mean something is
    // catastrophically wrong); not a proof about asymptotic behavior.
    expect(ms).toBeLessThan(5000);
  });
});

describe("NPR RSS 2.0 fixture", () => {
  it("parses and extracts known values, including CDATA-heavy items", () => {
    const root = parsedRoot("npr-news.rss2.xml");
    expect(root.tag).toBe("rss");
    expect(xmlText(xmlFind(root, "title"))).toBe("NPR Topics: News");

    const items = xmlFindAll(root, "item");
    expect(items.length).toBe(10);

    const first = items[0];
    expect(xmlText(xmlFind(first, "title"))).toBe(
      "After his Reflecting Pool vandalism case is dismissed, David Hearn looks for closure",
    );
    // RSS 2.0 links are element text, not attributes.
    expect(xmlText(xmlFind(first, "link"))).toBe(
      "https://www.npr.org/2026/08/10/nx-s1-5925117/reflecting-pool-david-hearn-legal-fight",
    );
    expect(xmlText(xmlFind(first, "pubDate"))).toBe("Mon, 10 Aug 2026 16:49:00 -0400");
    expect(xmlText(xmlFind(first, "dc:creator"))).toBe("Rachel Treisman");

    // content:encoded arrives via CDATA and must contain raw markup.
    const encoded = xmlText(xmlFind(first, "content:encoded"));
    expect(encoded).toContain("<p>");
  });
});

describe("sloppy constructed fixture (bare ampersands)", () => {
  it("recovers bare ampersands in URLs and text exactly", () => {
    const root = parsedRoot("sloppy-feed.rss2.xml");
    expect(xmlText(xmlFind(root, "link"))).toBe("https://example.com/feed?page=1&limit=10");

    const items = xmlFindAll(root, "item");
    expect(items.length).toBe(2);
    expect(xmlText(xmlFind(items[0], "title"))).toBe("Roads & bridges levy passes");
    expect(xmlText(xmlFind(items[0], "link"))).toBe("https://example.com/news/roads?id=42&ref=rss&utm_source=feed");
    expect(xmlText(xmlFind(items[0], "description"))).toBe("Voters approved the roads & bridges levy 60/40.");
    // Escaped and bare ampersands coexist.
    expect(xmlText(xmlFind(items[1], "title"))).toBe("Fish & chips fundraiser");
    expect(xmlText(xmlFind(items[1], "link"))).toBe("https://example.com/events?a=1&b=2&c=3");
  });
});
