// Content filter for text that other visitors will see (shared-route titles, descriptions,
// start/end labels). Three checks: markup or script, SQL-shaped input, and abusive language
// (profanity, racial / ethnic / sexist / homophobic slurs). Everything shown in the browser is
// also HTML-escaped on output; this filter is the second layer and the one that keeps the
// library civil.

// ---------- markup / script ----------
const MARKUP_RE = [
  /<\s*\/?\s*[a-z!?]/i, // any tag-like "<a", "</div", "<!--", "<?xml"
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  /\bon[a-z]{2,}\s*=/i, // onclick=, onerror=
  /&#x?[0-9a-f]+;|&(lt|gt|quot|apos);/i, // pre-encoded entities are only ever an evasion here
  /\{\{.*\}\}|\$\{.*\}/, // template syntax
];

// ---------- SQL-shaped ----------
const SQL_RE = [
  /\bunion\s+(all\s+)?select\b/i,
  /\b(drop|alter|truncate|create)\s+(table|database|index|view)\b/i,
  /\b(insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i,
  /\bselect\s+(\*|[\w`"]+(\s*,\s*[\w`"]+)+|\w+\s*\([^)]*\))\s+from\b/i, // select * from, select a,b from, select count(x) from
  /(['"`;])\s*(or|and)\s+['"`\d]/i, // ' or '1
  /['"`]\s*--/, // admin'--
  /\b\d+\s*=\s*\d+\b\s*(--|;|\/\*|$)/i, // 1=1--
  /;\s*--|\/\*[\s\S]*\*\//, // comment tricks
  /\b(xp_cmdshell|sp_executesql|information_schema|sqlite_master|pg_sleep|waitfor\s+delay|benchmark\s*\()/i,
];

// ---------- abusive language ----------
// Matched on a normalised copy of the text (lower-case, leet-speak undone, repeated letters
// collapsed) with word boundaries, so "Scunthorpe", "Dickens", "spicy" and "assassin" pass.
const BAD_WORDS = [
  // profanity
  "fuck", "fucker", "fucking", "motherfucker", "shit", "shitty", "bullshit", "bitch", "bitches",
  "asshole", "arsehole", "jackass", "dumbass", "cunt", "cock", "pussy", "wanker", "twat", "bastard",
  "whore", "slut", "dickhead", "prick",
  // racial / ethnic / religious slurs
  "nigger", "nigga", "niggers", "niggas", "negro", "chink", "chinks", "gook", "gooks", "spic", "spics",
  "wetback", "wetbacks", "beaner", "beaners", "kike", "kikes", "raghead", "towelhead", "sandnigger",
  "paki", "pakis", "coolie", "jap", "japs", "redskin", "redskins", "injun", "zipperhead", "gringo",
  "cracker", "honky", "honkey", "darkie", "darky", "coon", "coons", "jigaboo", "porchmonkey",
  "goyim", "heeb", "yid", "abo", "abos", "curry muncher", "camel jockey",
  // sexist / homophobic / transphobic / ableist
  "faggot", "faggots", "fag", "fags", "dyke", "dykes", "tranny", "trannies", "shemale", "homo",
  "retard", "retards", "retarded", "spastic", "cripple",
  // hate
  "white power", "heil hitler", "gas the", "kill all", "lynch",
];

// separate words → one regex alternation; multi-word entries keep their space
const WORD_RE = new RegExp(`(?<![a-z])(?:${BAD_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|")})(?![a-z])`, "i");

// Slurs people try to hide with dots/spaces ("n.i.g.g.e.r"). Checked on a letters-only squash;
// only entries with no innocent super-strings belong here.
const SQUASH_WORDS = ["nigger", "nigga", "faggot", "wetback", "raghead", "towelhead", "motherfucker", "porchmonkey", "jigaboo"];
const SQUASH_RE = new RegExp(SQUASH_WORDS.join("|"), "i");

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i", "|": "i", "+": "t" };

export function normalise(text) {
  let s = String(text || "").toLowerCase();
  s = s.replace(/[0134578@$!|+]/g, (c) => LEET[c] ?? c);
  s = s.replace(/[*]/g, "u"); // f*ck, sh*t
  s = s.replace(/([a-z])\1{2,}/g, "$1$1"); // fuuuuck → fuuck (regex below still needs exact spelling, so also try single)
  return s;
}

/** Letters only, for the hidden-slur check ("n.i.g.g.e.r", "n i g g e r"). */
function squash(text) {
  return normalise(text).replace(/[^a-z]/g, "");
}

/**
 * Check one piece of user text. Returns null when it's fine, otherwise a short reason:
 * "markup" | "sql" | "language". `what` is only used in the message returned by `assertClean`.
 */
export function check(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  if (MARKUP_RE.some((re) => re.test(s))) return "markup";
  if (SQL_RE.some((re) => re.test(s))) return "sql";
  const n = normalise(s);
  const n1 = n.replace(/([a-z])\1+/g, "$1"); // all repeats collapsed: "fuuuck" → "fuck"
  if (WORD_RE.test(n) || WORD_RE.test(n1)) return "language";
  if (SQUASH_RE.test(squash(s))) return "language";
  return null;
}

const MESSAGES = {
  markup: (what) => `The ${what} can't contain HTML tags, scripts or code.`,
  sql: (what) => `The ${what} looks like a database command. Please write it in plain words.`,
  language: (what) => `The ${what} contains language we don't allow on shared routes. Please keep it civil.`,
};

/** Throws an Error with `.status = 400` describing the first problem found across the fields. */
export function assertClean(fields) {
  for (const [what, text] of Object.entries(fields)) {
    const why = check(text);
    if (why) {
      const err = new Error(MESSAGES[why](what));
      err.status = 400;
      err.reason = why;
      throw err;
    }
  }
}
