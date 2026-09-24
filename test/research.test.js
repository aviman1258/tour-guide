import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, isSafeUrl } from "../server/lib/webpage.js";
import { forStop, keyFor, _useMemoryDb } from "../server/lib/research.js";

test("htmlToText keeps the title, description and real paragraphs, drops chrome", () => {
  const html = `<html><head><title>Kali Mandir &amp; Cultural Center</title><meta name="description" content="A Hindu temple in Laguna Beach, California."></head>
  <body><nav>Home About Donate</nav><header>Menu</header><script>var x=1;</script>
  <main><h1>Welcome</h1><p>Kali Mandir was founded in 1993 by devotees in Laguna Beach and holds daily aarati at 6 pm, with the annual Kali Puja festival each autumn.</p>
  <p>Cookie notice: accept all</p><p>Visitors are welcome; please remove shoes before entering the shrine room and dress modestly.</p></main>
  <footer>© 2026 Kali Mandir</footer></body></html>`;
  const t = htmlToText(html);
  assert.equal(t.title, "Kali Mandir & Cultural Center");
  assert.equal(t.description, "A Hindu temple in Laguna Beach, California.");
  assert.ok(t.text.includes("founded in 1993") && t.text.includes("remove shoes"));
  assert.ok(!t.text.includes("Donate") && !t.text.includes("var x") && !t.text.includes("© 2026"));
  assert.ok(htmlToText("<p>" + "word ".repeat(600) + "</p>", { maxChars: 500 }).text.length <= 502);
});

test("isSafeUrl rejects private, local and non-http targets", async () => {
  assert.equal(await isSafeUrl("http://localhost/admin"), false);
  assert.equal(await isSafeUrl("http://127.0.0.1:3001/"), false);
  assert.equal(await isSafeUrl("http://192.168.1.1/"), false);
  assert.equal(await isSafeUrl("ftp://example.com/"), false);
  assert.equal(await isSafeUrl("not a url"), false);
  assert.equal(await isSafeUrl("http://10.0.0.5/"), false);
});

test("forStop stacks Wikipedia, the website and web facts, labelled, and caches", async () => {
  _useMemoryDb();
  const calls = { wiki: 0, site: 0, page: 0, web: 0 };
  const deps = {
    wikiSummary: async () => { calls.wiki++; return { extract: "Kali Mandir is a Hindu temple in Laguna Beach.", url: "https://en.wikipedia.org/wiki/Kali_Mandir", wikibaseItem: "Q1" }; },
    officialSite: async () => { calls.site++; return "https://kalimandir.org/"; },
    fetchPage: async (url) => { calls.page++; return { url, title: "Kali Mandir", description: "A Hindu temple in Laguna Beach.", text: "Founded in 1993 by devotees. Daily aarati at 6 pm. Annual Kali Puja festival each autumn." }; },
    webFacts: async () => { calls.web++; return [{ fact: "The temple's murti of Kali was consecrated in 1995 by priests from Kolkata.", source: "https://example.org/history" }, { fact: "x", source: "" }]; },
  };
  const stop = { name: "Kali Mandir", lat: 33.5765, lon: -117.762, wikipediaTitle: "Kali Mandir", approxArea: "Laguna Beach, California" };
  const r = await forStop(stop, { interests: "hindu temples", deps });
  assert.ok(r.extract.includes("From Wikipedia (https://en.wikipedia.org/wiki/Kali_Mandir)"));
  assert.ok(r.extract.includes("From the place's own website (https://kalimandir.org/)") && r.extract.includes("Founded in 1993"));
  assert.ok(r.extract.includes("From the web") && r.extract.includes("consecrated in 1995") && !r.extract.includes("- x"), "short junk facts dropped");
  assert.deepEqual(r.from, ["wikipedia", "website", "web"]);
  assert.equal(r.sources.length, 3);
  assert.equal(r.thin, true, "under the threshold even with all three, so web search was consulted");
  const again = await forStop(stop, { interests: "hindu temples", deps });
  assert.equal(again.cached, true);
  assert.deepEqual(calls, { wiki: 1, site: 1, page: 1, web: 1 }, "second call is served from the cache");
});

test("forStop with a rich Wikipedia article skips the web search; a bare Google stop still gets something", async () => {
  _useMemoryDb();
  let webCalls = 0;
  const deps = { wikiSummary: async () => ({ extract: "A".repeat(900), url: "u" }), webFacts: async () => { webCalls++; return []; } };
  const rich = await forStop({ name: "Big Museum", lat: 1, lon: 2, wikipediaTitle: "Big Museum" }, { deps });
  assert.equal(rich.thin, false);
  assert.equal(webCalls, 0);
  const bare = await forStop({ name: "Tiny Bakery", lat: 3, lon: 4, source: "google", blurb: "bakery · 1 Main St", approxArea: "Somewhere, CA" }, { deps: { webFacts: async () => { webCalls++; return []; } } });
  assert.equal(webCalls, 1);
  assert.ok(bare.extract.includes("bakery"));
  assert.equal(keyFor({ name: "Tiny Bakery", lat: 3, lon: 4 }), "p:tiny bakery@3.000,4.000");
});
