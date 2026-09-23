# How Deodapper is built and run

The owner's manual. Everything third-party the site depends on, where each key comes from, what
breaks without it, and how the app itself is put together. Written so you can explain the whole
thing to someone in ten minutes or fix it at midnight.

Last updated 22 September 2026 (rates confirmed, spend guards added).

---

## 1. The 60-second version

Deodapper (deodapper.com) plans a self-guided driving day between two places around what the
visitor likes, then narrates each stop out loud as they drive past it. Visitors can drive a
route someone else published for free, or pay $1.99 to $4.49 to have one created for them.

It is one Node.js server and one static web app, shipped together in a Docker container on
Render. The server talks to Claude (Anthropic) for the stops and the narration, to Wikipedia and
OpenStreetMap for facts, coordinates and routing, and to Stripe for payments. The web app is an
installable progressive web app that works offline once a route is saved to the phone, using
the phone's own GPS and text-to-speech. There are no user accounts and no card data on our side.

---

## 2. Third-party services

| Service | What it does for us | Account | Keys / settings | Cost |
|---|---|---|---|---|
| **GitHub** | Source code, deploy trigger | github.com/aviman1258/tour-guide (personal account) | none in the app | free |
| **Render** | Hosts the server + site, persistent disk | render.com (Starter plan, service `tour-guide`) | all environment variables live here | ~$7/month |
| **Cloudflare** | Domain registration, DNS, support@ email forwarding | dash.cloudflare.com, zone deodapper.com | none in the app | ~$10/year domain |
| **Anthropic** | Claude models that plan stops and write narration | console.anthropic.com | `ANTHROPIC_API_KEY` | per use, ~$0.35/route est. |
| **Stripe** | Card payments, holds, refunds, payouts | dashboard.stripe.com, account `acct_1UIDdJ2clkS7h6Fg` | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | 2.9% + 30¢ per charge |
| **Google Search Console** | Tells Google the site exists, shows search stats | search.google.com/search-console, Domain property deodapper.com | verified via TXT record | free |
| **Bing Webmaster Tools + IndexNow** | Bing, DuckDuckGo and ChatGPT search; instant URL pings | bing.com/webmasters (import from Google) | `INDEXNOW_KEY` (self-chosen, public, served at `/<key>.txt`) | free |
| **Wikipedia / Wikimedia** | Place facts, coordinates, article summaries | none | identifying `User-Agent` (`CONTACT`) | free, rate-limited |
| **OpenStreetMap Nominatim** | Geocoding (address ↔ coordinates) | none | same `User-Agent`, 1 request/second | free |
| **Valhalla (FOSSGIS)** | Driving routes, avoid tolls/highways, turn instructions | none | `VALHALLA_BASE_URL` | free, public server |
| **OSRM demo** | Fallback router | none | `OSRM_BASE_URL` | free, no uptime promise |
| **Photon (komoot)** | Type-ahead place search in the browser and on the server (add-a-stop, grounding fallback) | none | none | free |
| **Google Places API (New)** (optional) | Last-resort search for small local places the free sources don't know | console.cloud.google.com | `GOOGLE_PLACES_KEY` | free monthly tier per SKU, then per call |
| **OpenStreetMap tiles** | The map images | none | none | free, fair use |
| **ipwho.is** | IP → approximate city for usage stats | none | none (`GEO_LOOKUP=0` disables) | free tier |
| **Open-Meteo** | Weather and temperature at each stop in drive mode | none | none | free, non-commercial tier (< 10k calls/day) |

The sections below say, for each one, what you did to set it up and what to do when something
changes.

### 2.1 GitHub

- Repo `aviman1258/tour-guide`, branch `main`. Every push to `main` triggers a Render deploy.
- A leftover GitHub Actions workflow (`.github/workflows/pages.yml`) also publishes the `web/`
  folder to GitHub Pages at aviman1258.github.io/tour-guide. It is harmless (drive mode works
  from there without a server) but deodapper.com is the real site. Delete the workflow if it
  ever confuses anyone.
- Nothing secret is in the repo. `.env` is gitignored; `env.sample` shows the variable names.

### 2.2 Render (hosting)

**What it runs:** the `Dockerfile` (Node 24 on Alpine Linux) with `render.yaml` as the
blueprint: web service `tour-guide`, Starter plan, Oregon region, Docker runtime, auto-deploy
from `main`, health check `GET /api/health`, and a 1 GB persistent disk mounted at `/app/data`.
That disk holds `deodapper.db` (SQLite: published routes, usage stats, Claude usage, payment
credits, owner tokens) and `timings.json` (learned time estimates). Lose the disk and you lose
those; the code doesn't care.

**Where the keys live:** Render → the service → **Environment**. This is the only place secrets
exist. Editing a variable redeploys automatically (about two minutes).

**Custom domain:** Render → service → Settings → Custom Domains has `deodapper.com`; Render
issued the TLS certificate. The service's own hostname is `tour-guide-i6kk.onrender.com`.

**Reading the logs:** Render → service → Logs. Lines start with `[claude]`, `[plan]`,
`[pay]`, `[analytics]` etc.

**Health check:** `https://deodapper.com/api/health` returns `ok`, whether the passphrase and
payments are configured, the data directory status, event and route counts, owner tokens and
lockouts, and the Claude transport (`sdk` on Render).

### 2.3 Cloudflare (domain, DNS, email)

- **Registrar:** deodapper.com is registered through Cloudflare Registrar (Domains →
  Registrations). Auto-renews yearly on the card on file.
- **DNS** (deodapper.com → DNS): a `CNAME` for `deodapper.com` and another for `www`, both
  pointing at `tour-guide-i6kk.onrender.com`, proxy status **DNS only** (grey cloud). Keep them
  DNS-only: Render terminates TLS itself. Render lists both as custom domains and redirects
  `www.deodapper.com` to the bare domain (301). There is also a `TXT` `google-site-verification=…` added by
  Google via the Cloudflare integration, and the MX/TXT records Email Routing added.
- **Email Routing** (Email → Email Routing → deodapper.com): custom address
  `support@deodapper.com` forwards to your Gmail. That address is on the terms and privacy pages,
  the landing footer and your Stripe account. Replying *as* support@ isn't set up; if you want
  it, Gmail's "Send mail as" with an app password is the usual way.
- If Render's hostname ever changes, update the CNAME here and the custom domain in Render.

### 2.4 Anthropic (Claude)

- **Key:** console.anthropic.com → API keys → Create key. Paste into Render as
  `ANTHROPIC_API_KEY`. Only the server uses it; the browser never sees it. Rotate by creating a
  new key, updating Render, then deleting the old one.
- **Models:** `claude-opus-5` plans stops and writes narration (`MODEL_STRONG`);
  `claude-haiku-4-5` handles "Suggest more" (`MODEL_FAST`). Both are env-overridable.
- **Billing model:** the account is **prepaid** (Billing → Credit balance) with auto-reload
  off. When the balance reaches zero the API refuses calls, so a runaway bill is impossible; the
  worst case is planning stops until you buy credits. Anthropic emails when the balance is low.
  If you ever turn auto-reload on, its monthly maximum becomes your cap. Inside the app, the
  daily budget breaker (`DAILY_CLAUDE_BUDGET_USD`) trips well before the balance is gone.
- **Pricing for the cost panel and the budget breaker:** every call is priced from
  `CLAUDE_RATES` (JSON, dollars per million tokens per model). Set in Render on 22 September
  2026 from the console's "Compare models" screen, which showed these standard list prices:

  | Model | Input / MTok | Output / MTok | Cache write | Cache read |
  |---|---|---|---|---|
  | Opus 5 (`claude-opus-5`) | $5 | $25 | $6.25 | $0.50 |
  | Sonnet 5 (`claude-sonnet-5`) | $2 | $10 | $2.50 | $0.20 |
  | Haiku 4.5 (`claude-haiku-4-5`) | $1 | $5 | $1.25 | $0.10 |

  Current value: `{"claude-opus-5":{"in":5,"out":25},"claude-haiku-4-5":{"in":1,"out":5}}`.
  The code applies the cache multipliers itself (write 1.25× input, read 0.1× input). When
  Anthropic changes prices, update this variable and this table. Where to look: console →
  Billing, or the model picker's **Compare models → Cost** tab.
- **A cheaper model is one variable away.** Sonnet 5 costs 60% less than Opus 5. To try it,
  set `MODEL_STRONG=claude-sonnet-5` in Render (and add a `"claude-sonnet-5":{"in":2,"out":10}`
  entry to `CLAUDE_RATES`), plan a few routes of your own, judge the stops and narration, and
  compare the per-route cost in the admin panel. Switch back by removing the variable.
- **Locally** (no key) the server shells out to the Claude Code CLI on your laptop instead, so
  development uses your Claude subscription. That path adds the CLI's own prompt overhead, so
  only trust the hosted numbers for pricing decisions.

### 2.5 Stripe (payments)

**Concepts.** Your Stripe *account* has a **live** side (real money) and **sandboxes** (fake
money, separate keys and webhooks). The sandbox is where everything was tested; the live side is
what deodapper.com uses now.

**Keys** (live mode, Developers → API keys):

- Publishable key `pk_live_…`: safe for the browser; it lets Stripe's payment form talk to your
  account. → `STRIPE_PUBLISHABLE_KEY`.
- Secret key `sk_live_…`: created with **Create a secret key**, shown once. The server uses it to
  create, capture and cancel payments. → `STRIPE_SECRET_KEY`. If lost, roll it and update Render.
- Webhook signing secret `whsec_…`: on the webhook destination page, **Reveal**. Proves that
  events posted to our server really came from Stripe. → `STRIPE_WEBHOOK_SECRET`.

**Webhook destination** (Developers → Webhooks, live mode): name `deodapper-live`, endpoint
`https://deodapper.com/api/pay/webhook`, five events:
`payment_intent.amount_capturable_updated`, `payment_intent.succeeded`,
`payment_intent.canceled`, `charge.refunded`, `charge.dispute.created`. The destination page
lists every delivery and the HTTP status our server returned; that is where to look if refunds
stop syncing. The sandbox has its own destination with the same settings.

**Activation** (Settings → Business → Account status): identity was completed; the remaining
task is **Provide an external account** (bank account for payouts). Charges work without it;
payouts wait in your Stripe balance until it's added. Add it through that task when the new bank
account exists.

**What the visitor sees:** one step, "Pay $2.99 and plan my tour", card only, optional receipt
email (Stripe sends the receipt; enable Settings → Emails → Successful payments). The copy says
"charged now, cancelled automatically if planning fails".

**Money flow:** card held when the visitor presses Pay → captured when the route is ready →
Stripe fee deducted → balance → paid out to your bank on Stripe's schedule (2 business days
rolling by default; changeable under Balances → Payout settings).

**Refunds:** Payments → open the payment → Refund. The webhook then closes the route credit on
our side within seconds. Disputes (chargebacks) do the same automatically and cost a $15 fee.

**Stripe Tax:** offered in the dashboard; not needed until sales are meaningful or your home
state clearly taxes digital services. Turning it on later needs a small app change.

**Statement descriptor** (Settings → Business → Public details): what appears on card
statements. Set to DEODAPPER.

**Test cards** (sandbox only): `4242 4242 4242 4242` succeeds, `4000 0025 0000 3155` asks for
bank confirmation, `4000 0000 0000 9995` declines.

### 2.6 Google Search Console

Domain property `deodapper.com`, verified through the Cloudflare integration (it added the TXT
record). Sitemap submitted as `https://deodapper.com/sitemap.xml`. Use **URL inspection →
Request indexing** after big content changes. Bing Webmaster Tools can import this property.

**Titles and descriptions are drafted by Claude** (Haiku, half a cent) when the publish form
opens, in a fixed shape: "City: two or three highlights" and a specific one-to-two-sentence
description with no brochure language. The publisher can edit or ask for another draft. This keeps
the public pages consistent and search-friendly without anyone having to write copy.

### 2.6a Bing, DuckDuckGo, ChatGPT

Google found the site on its own, but Bing's index (which DuckDuckGo and ChatGPT's browsing use)
is separate. Two things feed it: **Bing Webmaster Tools** (bing.com/webmasters → Import from
Google Search Console, one click, gives you Bing's reports) and **IndexNow**, which the server
does automatically: every published or deleted route is pinged to `api.indexnow.org` with
`INDEXNOW_KEY`, and the admin page's "Submit pages to Bing" button sends every public page at once.
The key is not a secret; it only has to match the file the server serves at
`deodapper.com/<key>.txt`. Rotate it by changing the variable; nothing else needs to change.

**Route pages are the SEO engine.** Every published route has a public page at
`deodapper.com/routes/<id>/<slug>` (title, stops, map, first line of each story, "Drive this
route free"), listed at `deodapper.com/routes` and in the sitemap automatically. Ranking for
"self-guided tours" in general is not realistic; ranking for "IAH to the Galleria scenic drive"
is, and each published route adds one such page. Publish routes for the cities you care about,
then use URL inspection → Request indexing on the new page once.

### 2.6b Google Places (optional)

The free sources have a blind spot: small local places. A neighbourhood temple like Kali Mandir
in Laguna Beach is in neither Wikipedia, Nominatim, Photon nor OpenStreetMap at all, so no free
lookup can find it. Google Places knows it. Setting it up: console.cloud.google.com → new
project ("Deodapper") → APIs & Services → Library → enable **Places API (New)** → Credentials →
Create API key → restrict the key to "Places API (New)" (Application restrictions: none, it's used
server-side) → paste into Render as `GOOGLE_PLACES_KEY`. Billing must be enabled on the project,
but Google gives each Places SKU a free monthly allowance; the app requests only "Pro" tier
fields (name, location, type, address), which has thousands of free Text Search calls a month, and
deliberately not ratings or summaries, which would bill every call at the Enterprise rate. At
Deodapper's volume this should cost nothing. Set a budget alert in Cloud Billing anyway.
When set, Google is the last fallback in grounding and in place search; stops it supplies show a
small "place data: Google" note, which Google's terms require. Leave it empty to run on free
sources only.

### 2.7 The free data services

No accounts, but each has rules the server follows:

- **Wikipedia/Wikimedia:** an identifying `User-Agent` with a contact (`CONTACT` env var, which
  should be `support@deodapper.com`), at most two concurrent requests, respect `429` and
  `Retry-After`. Results cached 24 h.
- **Nominatim:** one request per second, no autocomplete, identifying `User-Agent`. Cached 7 d.
- **Valhalla** (`valhalla1.openstreetmap.de`) and **OSRM** (`router.project-osrm.org`): public
  demo servers with no uptime guarantee; the app tries Valhalla first (it can avoid tolls and
  highways and gives spoken-style instructions) and falls back to OSRM.
- **Photon** and **OSM tiles** are called from the visitor's browser, so those services see the
  visitor's IP, which the privacy page discloses. Tiles must not be bulk-downloaded; the
  service worker only caches tiles the map actually showed.
- **ipwho.is:** one lookup per IP per week, cached; free tier is plenty.
- **Open-Meteo:** called from the phone in drive mode, one request per trip per half hour, all
  stops in a single call. Free for non-commercial use up to 10,000 calls a day; if Deodapper
  ever grows past that, their paid API is $29/month.

---

## 3. Environment variables (Render → Environment)

| Variable | Set by you? | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API key (section 2.4) |
| `APP_SECRET` | yes, invented | The **owner passphrase**. Knowing it makes a device the owner: free planning, publishing, deleting routes. Change it to lock everyone out; existing owner tokens keep working until they expire (180 days) |
| `ADMIN_SECRET` | yes, invented | Password for `/admin.html`. Unset = admin disabled |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | yes | Section 2.5. All three empty = payments off, passphrase-only site |
| `CONTACT` | yes | Email in the User-Agent sent to Wikipedia/OSM. Use `support@deodapper.com` |
| `INDEXNOW_KEY` | optional | Self-chosen key for IndexNow pings to Bing and friends (section 2.6a) |
| `GOOGLE_PLACES_KEY` | optional | Google Places API (New) key, last-resort place search (section 2.6b) |
| `CLAUDE_RATES` | optional | Per-million token prices for the cost panel and the budget breaker |
| `DAILY_CLAUDE_BUDGET_USD` | `25` default | Daily Claude spend after which planning, Suggest more and narration refuse until midnight UTC. `0` = off |
| `AI_CALLS_PER_HOUR` | `20` default | Per-IP hourly cap on those three routes for non-owners |
| `TRUST_PROXY` | `2` | Proxy hops in front of the app (Render's edge is Cloudflare). Wrong value = every visitor looks like one IP |
| `GEO_LOOKUP` | optional | `0` turns off the IP-to-city lookup |
| `MODEL_STRONG`, `MODEL_FAST` | blueprint | `claude-opus-5`, `claude-haiku-4-5` |
| `VALHALLA_BASE_URL`, `OSRM_BASE_URL` | optional | Router endpoints |
| `PORT`, `NODE_ENV` | blueprint | `3001`, `production` |

Two secrets are yours to invent and remember, not issued by anyone: `APP_SECRET` and
`ADMIN_SECRET`. Keep them in a password manager.

---

## 4. Runbooks

**Deploy a change.** Commit to `main`, push. Render builds and swaps in about two minutes; the
health check must pass or the old version stays. Any change under `web/` must bump
`SHELL_VERSION` in `web/sw.js` or installed phones keep the old files.

**Rotate any key.** Create the new one at the provider, paste into Render (same variable name,
replace the value), wait for the redeploy, then revoke the old one at the provider.

**Sandbox → live or back.** Replace the three `STRIPE_*` values together in one save. Nothing in
the code knows which mode it is in.

**Refund a route.** Stripe → Payments → the payment → Refund. Check `/admin.html` → Sales: the
credit flips to `refunded`.

**Crawler traffic.** Google and Bing render the pages, so they fire the same "page opened"
beacon as a person. They show under Devices as `bot/script · crawler`. "Unknown" locations are
rows from before the proxy fix on 21 September 2026; nothing can recover those.

**See what's happening.** `/admin.html` (password `ADMIN_SECRET`): visitors, where from, devices,
actions, Sales (revenue, holds, refunds), Claude cost per route, shared routes with Delete.
`/api/health` for a machine-readable status.

**Owner mode on a new phone.** Open deodapper.com → Create your own route → press and hold the
Deodap logo for a second → enter `APP_SECRET`. Three wrong tries lock that phone and IP for 24
hours (the server enforces it). To see the paying visitor's view on an owner device, hold the
logo again and choose to leave owner mode.

**Locked yourself out.** Wait 24 hours, or use a different network and device. (An admin reset
button is on the to-do list.)

**Run it locally.** `npm install`, `npm run dev`, open http://localhost:3001. With no
`ANTHROPIC_API_KEY` it uses the Claude Code CLI; with no `APP_SECRET` every visitor is the owner;
with no Stripe keys payments are off. `npm test` runs 71 unit tests.

**"Deodap has done all the planning it can afford today."** The daily budget breaker tripped:
the day's Claude spend reached `DAILY_CLAUDE_BUDGET_USD`. `/api/health` → `budget` shows today's
spend and when it resets (midnight UTC). Raise the variable in Render if it was a good day, or
wait. Check the admin cost panel for what caused it.

**Something is down.** Check `/api/health` first. If it fails, Render → Logs. If planning fails
but health is fine, it is usually Wikipedia rate limiting (`429`) or the routing servers; both
recover on their own. Payments failing: Stripe dashboard → Developers → Webhooks/Logs.

---

## 5. How the app is built

### 5.1 Technologies, and where each is used

| Technology | Used for | Where |
|---|---|---|
| **Node.js 24** | Server runtime, built-in test runner, built-in SQLite | `server/`, `test/` |
| **Express 4** | HTTP routes, static files, middleware (tiers, rate limits) | `server/index.js` |
| **SQLite via `node:sqlite`** | Published routes, usage stats, Claude usage, payment credits, owner tokens (one file, `data/deodapper.db`) | `server/lib/library.js`, `analytics.js`, `usage.js`, `pay.js`, `owner.js` |
| **Anthropic SDK** (`@anthropic-ai/sdk`) | Structured Claude calls with strict tool schemas | `server/claude.js` |
| **Stripe SDK** (`stripe`) | PaymentIntents with manual capture, webhooks | `server/lib/pay.js` |
| **Server-Sent Events** | Streaming progress while planning and preparing narration | `/api/plan`, `/api/prepare-drive`, `web/js/api.js` |
| **Vanilla JavaScript (ES modules)** | The whole front end; no framework, no bundler | `web/js/*.js` |
| **Leaflet 1.9** + OpenStreetMap tiles | The map | `web/js/map.js`, `web/vendor/leaflet/` |
| **Progressive Web App**: manifest + service worker | Installable on iPhone/Android, offline drive mode, cached shell | `web/manifest.webmanifest`, `web/sw.js` |
| **Geolocation API** | Following the car | `web/js/drive.js` |
| **Web Speech API** (`speechSynthesis`) | Narration and spoken directions with the phone's built-in voices | `web/js/speech.js` |
| **IndexedDB** + `localStorage` | Saved trips and drive state on the phone; settings, credit token, device id | `web/js/storage.js`, `web/js/config.js` |
| **Wake Lock API** | Keeps the screen on while driving | `web/js/drive.js` |
| **Stripe.js Payment Element** | The card form, in Stripe's iframe | `web/js/pay.js` |
| **Docker** | One container: server + static site | `Dockerfile` |
| **Render blueprint** | Infrastructure as a file | `render.yaml` |
| **GitHub Actions** | Legacy GitHub Pages deploy of `web/` | `.github/workflows/pages.yml` |
| **`node --test`** | 71 unit tests: scheduling, geofences, speech queue, turn voice, moderation, pricing, payments, owner lockout | `test/*.test.js` |
| **Playwright** (dev only, from a sibling repo) | Headless browser checks of real flows against local and hosted servers | scratch scripts, not in the repo |

About 9,600 lines of code across server, web and tests. Shared modules run in both places:
`web/js/schedule-core.js` (day timing), `web/js/routeMath.js`, `web/js/pricing.js`,
`web/js/format.js`.

### 5.2 The three big flows

**Timing** includes typical traffic (`web/js/traffic.js`): a fixed weekday/weekend curve by hour,
not live data. Real historical traffic would mean a paid routing API (Google Routes or TomTom)
and another account; the hook is `legFn` in `schedule-core.js`.

**Plan** (`server/plan.js`): the visitor gives start, end, a time window and interests. Claude
proposes 10 to 14 candidate stops with exact Wikipedia titles. The server grounds every one:
Wikipedia summary → title search → coordinates → Nominatim, dropping anything it can't verify
(nothing is invented). Valhalla routes the day; the schedule walks start-buffer, drive, parking,
stay; a lunch stop lands between 11:30 and 2:00; low-priority stops are trimmed until the day
fits. Progress streams to the browser as each stop is confirmed. The visitor can reorder, remove,
add (search, map tap, Suggest more), mark meal stops and re-time; every edit re-routes.

**Prepare drive** (`server/narrate.js`, `server/lib/wikiGeo.js`): the route is scanned in 5 km
circles for Wikipedia articles within 300 m of the road, filtered for quality and interest,
and Claude writes a 90 to 150 word script per stop and 40 to 70 words per drive-by, facts only
from the supplied extracts, tone-guarded (no tragedies on a pleasure drive). How many drive-bys a
leg gets depends on its driving time, not its length (`server/lib/legAllowance.js`), so a dense
Manhattan hop gets a story every few blocks and a highway leg every few miles. The result, the
"drive package", is saved in the phone's IndexedDB.

**Drive** (`web/js/drive.js` and friends): fully on the phone, offline-capable. GPS fixes are
projected onto the route; a geofence state machine (`geofence.js`) fires each narration once,
approaching, with cooldowns; a speech queue (`speech.js`) plays it with the chosen voice, lets
stops interrupt drive-bys, and lets turn prompts pause and resume stories; `turnVoice.js`
speaks directions in Talkative / Reserved / Mute modes ("in half a mile", "in 200 feet", "in
100 feet", "turn now"); the banner shows the next turn or an off-route arrow. A simulator
(`sim.js`) replays any route at up to 60× for testing.

### 5.3 Tiers, payments and access

Every API request is stamped `subscriber` (the owner, via passphrase or owner token) or `free`.
Free visitors can search, load, re-time, save and drive published routes, rate-limited per IP.
Planning, Suggest more, narration and publishing need either the owner or a **route credit**:
a Stripe hold bound to the start/end pair, good for three plans, three narration preparations,
ten Suggest-more calls, edits and publishing for 30 days. The hold is captured the moment the first plan succeeds; failed or cancelled plans
leave it uncaptured and a sweep releases it before Stripe's 7-day limit. Pricing follows the
time window: Short outing ≤3 h $1.99, Half day ≤6 h $2.99, Full day $4.49.

### 5.4 Safety rails

- Published text (titles, descriptions, labels) passes a filter for markup, SQL-shaped input and
  abusive language; output is HTML-escaped as well.
- The owner passphrase is exchanged for a token and never stored in the browser; three wrong
  guesses per device or IP mean a 24-hour lockout.
- Card data never touches our server; the webhook payload is never logged.
- Usage stats keep IP, approximate city, device family and action for 90 days. No names, no
  emails, no GPS from the phone. Cloudflare's country header and a cached IP lookup give the city.
- All Claude output is validated against strict JSON schemas; word counts and facts-in-extract
  rules are checked before narration is accepted.
- The Claude bill is bounded four ways: per-credit quotas, an hourly per-IP cap on the AI routes,
  a daily spend breaker in the server (default $25), and Anthropic's prepaid balance with
  auto-reload off, which is a hard stop.

---

## 6. What it costs to run

| Item | Amount |
|---|---|
| Render Starter | about $7/month |
| Domain (Cloudflare Registrar) | about $10/year |
| Anthropic | per route, roughly $0.30 to $0.60 (check the admin cost panel for the real median); capped at `DAILY_CLAUDE_BUDGET_USD` a day and by the prepaid balance |
| Stripe | 2.9% + 30¢ of each captured payment; $15 per dispute |
| Everything else | free |

At the current prices a route nets roughly $1.35 (short) to $3.45 (full day) after Stripe and
Claude. The admin cost panel exists so these numbers can be re-checked from real data.

---

## 7. If someone asks "how did you build this?"

"It's a Node and Express server with a plain-JavaScript progressive web app, in one Docker
container on Render, with SQLite for the little data it keeps. Claude plans the stops and writes
the narration from Wikipedia and OpenStreetMap data, all verified server-side so nothing is made
up. The drive part runs entirely on the phone: GPS, geofences, the phone's own text-to-speech,
offline once a route is saved. Payments are Stripe holds that are only captured when the route is
actually delivered, and the site never sees a card number. About ten thousand lines, seventy
unit tests, deployed on every push."
