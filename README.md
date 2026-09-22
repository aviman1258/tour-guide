# Deodapper — Self-Guided Tour Creator

Named for Deodap, an elephant Avishek met; a cartoon of him (`web/img/deodap.svg`, with his
speckled ears and a garland) is the logo, and the PNG icons are rendered from it.
Live at https://deodapper.com.

Plan a self-drive day between an airport (or wherever you are) and your hotel, built around
what you're into, timed to your check-in, drawn on a map. Then take it in the car: an
installable web app that follows you by GPS and narrates each stop, plus the interesting
things you pass on the way, through the phone's own text-to-speech.

Personal project. First trip: Houston, November 2026.

Owner's manual, every third-party service, key and runbook: [docs/how-deodapper-is-built.md](docs/how-deodapper-is-built.md).

## Run

```bash
npm install
cp env.sample .env      # optional: add ANTHROPIC_API_KEY
npm run dev             # http://localhost:3001
npm test
```

With no API key the server shells out to the Claude Code CLI (`claude -p --json-schema`),
so it works on a Claude subscription. Each plan is one Claude call (about 10-40 s) plus
Wikipedia and Nominatim lookups for every candidate.

## Tiers and the shared route library

`/` is a landing page with two doors. **Subscriber** (`plan.html?tier=subscriber`) is the full
planner; on a hosted server it asks once per device for the passphrase (`APP_SECRET`), which the
server treats as the subscriber tier. Passphrase and admin-password prompts are a masked
`<dialog>` with a Show/Hide toggle (`web/js/secretPrompt.js`), never a plain `window.prompt`. **Free** (`plan.html?tier=free`) hides every AI control and
shows "Find a saved route" instead: routes that subscribers published, searchable by text or
"near me". A free driver picks one, sets their own date and start time (re-timing only; stops are
fixed because the narration is tied to them), saves it to the phone and drives it exactly like a
subscriber would.

Server side (`server/index.js`): every `/api` request is stamped `subscriber` or `free`. Plan,
suggest, prepare-drive and publish require subscriber; place search, re-timing and the library are
open but rate-limited per IP for free traffic (`server/lib/ratelimit.js`, 90 requests / 10 min).
The library (`server/lib/library.js`) is SQLite via Node's built-in `node:sqlite` at
`data/deodapper.db` on the persistent disk: `GET /api/routes?near=lat,lon&q=` searches,
`GET /api/routes/:id` returns the full drive package (and counts a use), `POST /api/routes`
publishes `{package, title, description}` (start/end labels that look like street addresses are
refused so nobody publishes their home), `DELETE /api/routes/:id` removes one.

Publishing sends the **prepared package** for the plan on screen, found by trip id or, failing
that, by content (same start, end and stops in order, any date; `web/js/planMatch.js`). If the
plan was edited after Prepare drive, or never prepared, publishing stops with a message instead
of falling back to the last active trip (which used to publish old stops under a new title).
"Save to this phone" applies the same check before merging the re-timed schedule into a library
route.

### Paying for a route (Stripe)

"Create your own route" is pay-per-route, no subscription. The price follows the time window,
because the number of stops (and so the Claude cost) does (`web/js/pricing.js`, shared with the
server):

| Tier | Window | Price |
|---|---|---|
| Short outing | up to 3 h | $1.99 |
| Half day | 3 to 6 h | $2.99 |
| Full day | over 6 h | $4.49 |

One payment is a **credit** bound to a start/end pair (coordinates rounded to ~1 km). It covers
3 plans (the first plus two re-plans, as long as the day doesn't grow into a higher tier), edits,
up to 10 Suggest-more calls, up to 3 narration preparations, and publishing for that route, for
30 days (`PLANS_PER_CREDIT`, `SUGGESTS_PER_CREDIT`, `PREPS_PER_CREDIT` in `web/js/pricing.js`).

### Keeping the Claude bill bounded

Three guards sit in front of `/api/plan`, `/api/suggest` and `/api/prepare-drive`, in this order:

1. **Daily budget breaker** (everyone, owner included): when the day's Claude spend, summed from
   the usage log at `CLAUDE_RATES` prices, reaches `DAILY_CLAUDE_BUDGET_USD` (default 25), the
   AI routes answer 503 "Deodap has done all the planning it can afford today" until midnight UTC.
   Health and the admin cost panel show today's spend against the limit. `0` disables it.
2. **Hourly per-IP cap** for non-owners: `AI_CALLS_PER_HOUR` (default 20) across the three
   routes, so a script can't hammer a paid credit.
3. **Per-credit quotas**: 3 plans, 3 narration preps, 10 suggestions; the fourth of each is a 402
   with a plain-English reason. Quotas are counted only when a call succeeds.

The account-level backstop is Anthropic's prepaid credit balance (auto-reload off): when it runs
out the API stops, holds are released, nobody is charged.

Flow: the Plan button shows the price for the current times. Pressing it opens a card with
Stripe's Payment Element; `POST /api/pay/intent` creates a PaymentIntent with **manual capture**,
so the amount is held, not charged. After the bank confirms, `POST /api/pay/confirm` reads the
intent back and the credit becomes `authorized`; planning runs with the credit token in an
`x-credit` header; when the plan succeeds the server captures the hold (`captured`). Failed or
cancelled plans leave the hold in place for another try; Cancel on the card, or an hourly sweep
a day before Stripe's 7-day limit, releases it. Stripe's webhook
(`POST /api/pay/webhook`, events `payment_intent.amount_capturable_updated`, `.succeeded`,
`.canceled`) mirrors any state change we didn't see ourselves. Two more events close the loop
with the Stripe dashboard: `charge.refunded` marks the credit `refunded` and
`charge.dispute.created` marks it `disputed`; either way the credit stops unlocking planning,
narration and publishing, and the Sales panel counts it. Register all five events on the
webhook destination.

Owner mode has no visible control: **press and hold the Deodap logo** in the plan page header
for about a second (`web/js/ownerGesture.js`), or open `plan.html?owner`. Not the owner → the
passphrase prompt; already the owner → an offer to leave owner mode on that device, which is how
to see the paid flow as a visitor would.

The passphrase is never kept in the browser. `POST /api/owner/unlock` exchanges it for a random
token (`server/lib/owner.js`, stored hashed, 180 days) that travels in `x-app-key`; devices
unlocked before tokens existed still work with the raw passphrase in that header. **Brute-force
guard:** every wrong guess, whether at the unlock endpoint or as a bad `x-app-key`, counts against
the caller's IP and the browser's random `x-device` id. Three wrong guesses lock both for 24
hours: unlock answers 429, and during the lock even the right passphrase is ignored. A stale
token counts once, not once per request. `GET /api/health` reports live tokens and current locks
under `owner`; the admin activity log shows `owner_unlock`, `owner_wrong` and `owner_locked`
events.

Gates (`requireAccess` in `server/index.js`): the owner passphrase (`APP_SECRET`) always passes;
otherwise `/api/plan` needs a credit with plans left, and `/api/suggest`, `/api/prepare-drive`
and `POST /api/routes` need a credit for that route. A refusal is a 402 with `needsPayment: true`
and the current quote; the client opens the pay card and retries once. With no Stripe keys set,
payments are off and the passphrase is the only door (local development).

What we store (`credits` table): credit id, a SHA-256 of the browser token, tier, amount,
PaymentIntent id, status, timestamps, the route signature, plans used, and the IP that bought it.
No card data, names or emails: Stripe holds those, and the webhook payload is never logged.
`GET /api/admin/sales` and the admin page's **Sales** panel show revenue and recent credits.

`web/terms.html` (what it is, prices, hold-then-capture, refund rules, use-it-sensibly, publishing,
availability) and `web/privacy.html` (what is kept, what isn't, the outside services involved) are
linked from the landing page footer and the payment card. Stripe's activation review looks for
exactly these, plus a contact address: both pages use `support@deodapper.com`, which needs to exist
(Cloudflare Email Routing forwards it for free).

Env: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` (all three from the
Stripe dashboard; sandbox keys for testing, test card `4242 4242 4242 4242`). Register the webhook
destination at `https://<host>/api/pay/webhook`.

Later: accounts, if ever needed; the credit check is the one place to change.

### Content filter on published routes

`server/lib/moderation.js` checks every piece of text other drivers will read (title,
description, start/end labels, interests, stop names) before a route is stored, and rejects
with a 400 that names the field:

- **markup / script** — anything tag-shaped, `javascript:` URLs, `on…=` handlers, pre-encoded
  entities, template syntax.
- **SQL-shaped input** — `union select`, `drop table`, `' or '1`, `admin'--` and friends. Plain
  English with the word "select" or "update" in it passes; queries are parameterised anyway, so
  this is about keeping junk out of the library, not about protecting the database.
- **abusive language** — profanity plus racial, ethnic, religious, sexist, homophobic, transphobic
  and ableist slurs, matched as whole words on a normalised copy (lower-case, leet-speak undone,
  stretched letters collapsed), and a letters-only pass for dotted-out slurs. Whole-word matching
  keeps "Scunthorpe", "Dickens" and "spicy" legal. The word list lives at the top of the module.

Output is HTML-escaped everywhere too; the filter is the second layer. `test/moderation.test.js`
holds the pass/fail examples.

## Usage analytics and the admin page

`server/lib/analytics.js` records one row per page open and per API action (plan, prepare,
publish, route search/use, errors): time, IP, coarse location, tier, device and browser
family, event kind, a short detail, duration. Nothing typed into forms, no names, no phone GPS.
Location comes from Cloudflare's visitor-location headers when the domain is proxied through
Cloudflare (Rules → Settings → *Add visitor location headers*), otherwise from a cached
ipwho.is lookup per IP (`GEO_LOOKUP=0` to disable). Render's own edge is Cloudflare too, so
`cf-ipcountry` always arrives; country alone still triggers the city lookup. The row is written the moment the request
arrives; the location is filled in afterwards, so a slow or failed lookup never loses the visit.
Rows older than 90 days are purged.

If the admin page looks empty, check `GET /api/health` first. Its `data` block reports whether
the data directory exists and is writable, how many events and routes are stored, whether
`ADMIN_SECRET` is set, and `analytics: {inserted, geoFilled, lastInsertAt, lastError}` for the
running process. `lastError` carries the last insert or ipwho.is failure verbatim.

Every Claude call is also logged (`server/lib/usage.js`, table `claude_calls`): tool, model,
transport, input/output/cache tokens, duration, and cost. Cost comes from the SDK's usage
object priced with `CLAUDE_RATES` (JSON, USD per million tokens, e.g.
`{"claude-opus-5":{"in":5,"out":25},"claude-haiku-4-5":{"in":1,"out":5}}`, which matched
Anthropic's list prices on 22 September 2026 and is what production has set; the built-in
defaults are the same numbers but the panel labels them "verify" until the variable is set) or,
on the CLI path, from the CLI's own
`total_cost_usd`. `GET /api/admin/costs?days=` summarises it, and the admin page shows a
**Claude cost** panel with the median cost of a finished route (plan + narration). That number
is what per-route pricing is calibrated against. Calls are labelled `propose_itinerary`,
`suggest_more` and `write_narration`. Only trust SDK (hosted) numbers for pricing: on the CLI
path the Claude Code CLI adds its own prompt, so a tiny call shows ~9k input tokens.

`/admin.html` shows it: cards, visitors per day, where from, devices, pages, actions, most active
addresses, recent events. It also lists every **shared route** with a Delete button, for taking
down anything that slipped past the content filter (`GET/DELETE /api/admin/routes`; deletions are
recorded as `admin_delete` events). It has its own password, `ADMIN_SECRET` (asked once per browser
session, kept in sessionStorage). With `ADMIN_SECRET` unset the admin API answers 404.

## How planning works

1. **Claude proposes** 10-14 candidate stops for your interests along the start→end corridor,
   with an exact Wikipedia article title, a category, a dwell time and a priority for each.
2. **The server grounds every candidate**: Wikipedia REST summary → title search →
   coordinates batch → Nominatim geocode → drop. Anything it can't place is listed under
   "not found", nothing is invented.
3. **Routing** (`server/router.js`): Valhalla's public server routes the day, honouring
   *Avoid tolls* / *Avoid highways* when ticked and flagging when no such route exists; the
   OSRM demo server is the fallback for plain routes. The schedule is walked from your start
   time plus a 30 min buffer: drive + 3 min parking + dwell per stop.
4. **Lunch** lands on the highest-priority food-friendly stop you reach between 11:30 and
   2:00 (ties go to the one nearest 12:30) and gets an hour. Any number of stops can be made
   meal breaks by hand with **Stop here to eat** (breakfast, dinner, a second lunch); each gets
   at least an hour and is tagged "meal". A hand-picked meal that falls inside the lunch window
   replaces the automatic pick; meals at other times leave it in place. Trimming never drops a
   meal stop while a non-meal stop of the same priority remains.
5. **Trimming**: while there are 6+ stops, the lowest-priority stop is cut. Below that,
   stays are shortened toward sensible minimums first (low-priority stops give up their
   time first, lunch keeps 45 min) because several quick stops beat two long ones; only
   then are more stops cut. Once OSRM's real timings come back, the best cut stop is added
   back if there's 20+ min to spare. Cut stops show under "Didn't fit" with *Add back*.

Edits (reorder, remove, add by search, tap the map, "Suggest more", "Stop here to eat", dwell) all
re-route and re-schedule but never trim on their own.

**Progress while planning.** `POST /api/plan` with `Accept: text/event-stream` streams events
(`estimate`, `phase`, `candidates`, `stop`, `dropped`, `done`, `error`; see `server/plan.js`), so
the page lists Claude's candidates as soon as they exist and ticks each one off as it is
verified. The estimate comes from the medians of the last 20 real runs per phase, stored in
`data/timings.json` (gitignored; priors until the first run). `GET /api/estimate` exposes it.
Cancel closes the connection; the server aborts the Claude call and stops.

## Shapes

```js
Stop = { id, name, lat, lon, category, whyItMatches, blurb, thumbnail, wikipediaTitle, wikipediaUrl,
         source: "wikipedia"|"nominatim"|"pin", dwellMinutes, priority: 1..5, isFoodOption,
         lunch: "none"|"auto"|"user", approxArea }

Itinerary = { version: 1, start:{label,lat,lon}, end:{label,lat,lon}, date, arrivalTime:"11:30", deadline:"15:00",
              departBufferMinutes, safetyBufferMinutes, interests, stops: Stop[],
              route: { geometry (GeoJSON LineString), legs:[{durationSec, distanceM, steps[]}], totalSec, totalM },
              schedule: { items:[{stopId, arrive, depart, legMinutes}], hotelArrive, slackMinutes,
                          status:"ok"|"tight"|"late", lunchStopId, warnings[] },
              dropped: [{name, reason:"not_found"|"too_far"|"trimmed", stop?}], summary }
```

Times are local `HH:MM` strings; all math is minutes-since-midnight, no time zones.

## API

| Route | Body / query | Returns |
|---|---|---|
| `GET /api/health` | | `{ok, claude:"sdk"\|"cli", models, osrm, data:{dir, exists, writable, events, routes, admin, analytics}}` |
| `GET /api/admin/costs?days=` | `x-admin-key` | Claude usage: per-tool calls, median tokens and cost, totals, median cost per route |
| `GET /api/admin/routes` | `x-admin-key` | `{routes: [summary + author]}` every shared route, newest first |
| `DELETE /api/admin/routes/:id` | `x-admin-key` | 204; removes a shared route for everyone |
| `POST /api/owner/unlock` | `{passphrase}` + `x-device` | `{token, expiresAt}`; 401 wrong (`triesLeft`), 429 locked (`lockedUntil`) |
| `POST /api/owner/logout` | `x-app-key` | revokes that owner token |
| `GET /api/pay/quote?arrivalTime=&deadline=` | | `{enabled, publishableKey, quote:{tierId,label,price,…}, plansPerCredit}` |
| `POST /api/pay/intent` | `{start, end, arrivalTime, deadline}` | `{token, clientSecret, quote, credit}` — a held (uncaptured) PaymentIntent |
| `POST /api/pay/confirm` | `{token}` | credit view after reading the intent back from Stripe |
| `GET /api/pay/credit?start=lat,lon&end=lat,lon&arrivalTime=&deadline=` | `x-credit` | `{credit, usable, reason}` |
| `POST /api/pay/release` | `{token}` | cancels an unused hold |
| `POST /api/pay/webhook` | Stripe signature | mirrors PaymentIntent state onto the credit |
| `GET /api/admin/sales?days=` | `x-admin-key` | revenue, credits by status and tier, recent credits |
| `GET /api/whoami` | | `{tier, protected, ip, forwarded, cf}` — the tier the server sees for you, your resolved IP, the raw `X-Forwarded-For` chain and any `cf-*` headers |
| `POST /api/plan` | `{start, end, arrivalTime, deadline, interests, date?}` | full `Itinerary` (grounded, routed, scheduled, trimmed) |
| `POST /api/schedule` | `{itinerary, trim?}` | itinerary with `route` + `schedule` recomputed |
| `POST /api/suggest` | `{itinerary, count}` | `{candidates: Stop[]}` not already in the plan |
| `GET /api/place?q=&near=lat,lon` | explicit submit only | `{results: Stop[]}` |
| `GET /api/reverse?lat=&lon=` | | `Stop` for a map click |
| `POST /api/prepare-drive` | `{itinerary}` | drive package with narration (see drive mode) |

## Upstream etiquette

- **Wikipedia**: identifying `User-Agent` (set `CONTACT` in `.env`), ≤5 concurrent, results cached 24 h.
- **Photon** (komoot, `photon.komoot.io`): the start/end type-ahead, called from the browser, debounced 250 ms, min 3 chars, cached per query. Also reverse-labels "current location".
- **OurAirports** (public domain): `web/data/airports.json` bundles ~4,000 airports with IATA codes and scheduled service so "SNA" or "heathrow" resolve instantly and offline. Regenerate with `node scripts/build-airports.mjs`.
- **Nominatim**: strictly 1 request/second through one queue, never autocomplete (policy), cached 7 days. Used for explicit "Add a stop" searches, map taps and grounding.
- **Valhalla public server** (FOSSGIS): fair use, spaced requests, no uptime guarantee. `VALHALLA_BASE_URL` to self-host.
- **OSRM demo server**: 1 request/second, no uptime guarantee, no toll/highway avoidance. Fallback only; `OSRM_BASE_URL` to change.
- **OSM tiles**: attribution stays visible; no bulk pre-fetch (policy). Drive mode uses live tiles over cell data.

## Layout

```
server/   Express API: claude.js (SDK or CLI), resolve.js (grounding), schedule.js (+ OSRM),
          wikipedia.js, nominatim.js, osrm.js, stops.js, narrate.js (drive prep), lib/
web/      static app, no build step. index.html = plan/edit, drive.html = drive mode.
          js/schedule-core.js + js/routeMath.js are shared with the server.
test/     node --test
```

## Drive mode

`web/drive.html`. Everything the car needs is prepared beforehand and stored on the phone, so
the drive itself needs no server and no Claude, only cell data for map tiles.

### Prepare drive (`POST /api/prepare-drive`, `server/narrate.js`)

1. Route with turn steps from OSRM (reused from the plan when present).
2. Sample the route every 6 km and geosearch Wikipedia within 5 km of each sample
   (`server/lib/wikiGeo.js`): about 15 calls per trip, one at a time with a pause, retried
   when Wikipedia says it's busy. Wikimedia rate-limits anonymous API traffic per IP, and a
   shared office connection trips that easily, so this stage is deliberately slow (1-2 min).
3. Keep only articles within 300 m of the actual road (exact distance to the polyline). Drop
   administrative areas, "List of …", school, hospital and highway stubs, anything within 300 m
   of a planned stop; fetch intro extracts, page length and 30-day pageviews; keep real articles
   (≥ 3000 bytes, ≥ 200 chars of intro); score by popularity, type and interest keywords; keep
   up to 8 candidates per leg, spread at least 1.5 km apart.
4. One Claude call writes every script: 90-150 words per stop, 40-70 per drive-by, at most two
   drive-bys per leg, none on legs under 3 km, only facts from the supplied extract, no
   "left/right". The server validates word counts and drops scripts that name unknown places.
   A stop Claude skipped gets a plain fallback so it is never silent.
   With `Accept: text/event-stream` the endpoint streams progress (`estimate`, `phase`, `scan`,
   `candidates`, `narration`, `done`), so the page shows the scan advancing, what was found on
   each leg, and each script as it lands; Cancel aborts the Claude call. Estimates come from
   the recorded durations of earlier runs (`data/timings.json`).
5. The result is a *drive package*: `{ tripId, preparedAt, itinerary (with route.steps),
   narration:[{id, kind:"stop"|"driveby", targetId|pageid, title, text, lat, lon, radiusM, alongM, legIndex}] }`,
   saved to IndexedDB (`web/js/storage.js`). Export/Import moves it between devices as a JSON file.

### On the road (`web/js/drive.js`)

- **Start drive** does three things synchronously inside the tap, in this order: speaks
  "Starting tour" (iOS only allows speech after a user gesture), requests a screen Wake Lock,
  starts `watchPosition`. Coming back from the background re-acquires the lock, restarts GPS
  and restarts the current narration (iOS wedges the speech engine otherwise).
- Each fix is projected onto the route (`routeMath.project`) to get progress along the route
  and off-route distance. 75 m off for 3 fixes = off route: the banner switches to a bearing
  arrow toward the next stop, geofences keep working on raw distance. Under 40 m = back on.
- **Geofence** (`web/js/geofence.js`, pure, unit-tested): a narration fires once, when you are
  inside its radius *and getting closer*. Stops use their own radius (250 m; 600 m for
  neighborhoods). Drive-bys widen to `speed × 20 s` (max 800 m) so they start before you pass,
  are gated to their position along the route, never play within 60 s after a stop narration
  or inside 1.5× a stop radius, and are dropped if you have already passed them by the time
  they reach the front of the queue.
- **Speech** (`web/js/speech.js`): one voice at a time; a stop interrupts a drive-by, drive-bys
  wait. Text is spoken sentence by sentence so Skip is instant and Chrome's long-utterance
  cutoff never hits. Watchdog timers cover the iOS `onend` bug.
- A stop counts as **visited** after 20 s stopped inside its radius, when you leave it again,
  when route progress passes it by 1.2 km, or when you tap *Visited*. Fired/visited state is
  persisted so a page reload mid-drive does not replay anything.
- **Next-turn banner** from the route steps, with a green "✓ On route" line while the car is
  on the line and an off-route card (bearing arrow + distance to the next stop) when it isn't.
- **Spoken directions** (`web/js/turnVoice.js`, a 3-position slider under the controls,
  remembered per device, default Reserved):
  - *Talkative* — after each turn, "Keep going straight on X for 1.3 miles"; every two minutes
    on a long stretch, "You're on the route. Next, turn left onto Y in 2.1 miles"; then the
    approach below. Also a one-line heads-up for "continue onto" steps.
  - *Reserved* — only the approach: "In half a mile / a quarter mile, turn left onto Y",
    "In 200 feet, …", "In 100 feet, …", "Turn left now." (the far prompt is skipped when the
    turn is already under 0.2 mi away; "continue" steps are silent).
  - *Mute* — banner only.
  Both speaking modes say "Back on the route." after an off-route spell. In the speech queue a
  newer turn prompt replaces a pending or playing one. The turn prompts themselves interrupt any
  narration (stop or drive-by); the story pauses, the prompt plays, and the story resumes from the
  sentence it was on. The informational lines (keep going, reassurance, back on the route) never
  interrupt: they are dropped while narration plays.

### Simulation

`drive.html?sim=1` replaces GPS with a replay along the route at 1×/5×/20×/60×, pauses 25 s
inside each stop, has a scrub bar, "jump to next event" and an "off-route" nudge. Everything
downstream (geofence, speech, banner, persistence) is the real code. Desktop Chrome speaks
after the Start click.

### Hosting the server (Render)

`Dockerfile` + `render.yaml` run the whole app (API + web) as one always-on Render Starter
service with a 1 GB disk at `/app/data` for the learned estimates. In Render: **New → Blueprint**,
pick this repo, then set the secrets it asks for:

- `ANTHROPIC_API_KEY` — planning and narration go through the API on a hosted server (there is no
  Claude Code login there). Set a monthly spend limit in the Anthropic console.
- `APP_SECRET` — a passphrase; every `/api/*` call except the health check must carry it. The app
  asks for it once per device (`x-app-key` header, kept in localStorage).
- `CONTACT` — an email or URL for the Wikipedia/OSM User-Agent.
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` — pay-per-route (see
  "Paying for a route"). Leave all three empty to run passphrase-only.
- `DAILY_CLAUDE_BUDGET_USD` — daily Claude spend breaker (default `25`, `0` = off); see "Keeping
  the Claude bill bounded".
- `AI_CALLS_PER_HOUR` — per-IP cap on plan/suggest/prepare for non-owners (default `20`).
- `CLAUDE_RATES` — optional; USD per million tokens per model for the cost panel (see the
  analytics section). Production has it set to the September 2026 list prices; without it the
  built-in defaults (same numbers) are used and the panel says "verify".
- `TRUST_PROXY` — how many proxy hops sit in front of the app (default `2`: Render's edge goes
  through Cloudflare, so `X-Forwarded-For` is `visitor, cloudflare`). If you later proxy your own
  domain through Cloudflare too, set `3`. `GET /api/whoami` echoes the `ip` the app resolved and the
  raw `forwarded` chain, so you can check it. A wrong value logs and rate-limits every visitor as
  one address.

Point your domain at the service (Cloudflare CNAME → the `onrender.com` host, then add the custom
domain in Render for the certificate). Install the PWA from that domain; planning, prepare-drive
and drive mode all work from the phone. The browser also keeps its own history of run times
(`web/js/timings.js`), so estimates survive redeploys and host changes regardless.

### Search engines

`web/robots.txt` allows everything except `/api/`, the admin page and drive mode (an app screen
with nothing to index), and points at `web/sitemap.xml` (landing, plan, terms, privacy). The
landing page carries a canonical link, Open Graph and Twitter cards with `web/img/og.png`
(1200×630, rendered from the mascot SVG), and JSON-LD describing a `WebApplication` with the four
offers, so search results can show the prices. `plan.html` has its own title and description;
`drive.html` and `admin.html` are `noindex`. Getting indexed still needs a one-time step in
Google Search Console: add `deodapper.com` as a Domain property, prove ownership with the TXT
record it gives you (Cloudflare → DNS), submit `https://deodapper.com/sitemap.xml`, and request
indexing of the homepage. Bing Webmaster Tools can import the Search Console property.

### PWA and hosting

Live at https://aviman1258.github.io/tour-guide/ (drive screen: `/drive.html`). Every push to
`main` redeploys `web/` via `.github/workflows/pages.yml`. **Bump `SHELL_VERSION` in `web/sw.js`
whenever files under `web/` change**, or installed phones keep serving the old cached shell.

`manifest.webmanifest` + `sw.js`: the app shell (including vendored Leaflet) is cached for
offline; map tiles are cached only after the map requested them (OSM policy forbids
pre-fetching); `/api/*` is never cached. `.github/workflows/pages.yml` publishes `web/` to
GitHub Pages so the phone can install it over HTTPS; planning stays on the laptop and the trip
travels as an exported JSON file (AirDrop, iCloud, email) imported *inside the installed app*
(iOS keeps Home Screen app storage separate from Safari).

Before you leave the hotel, run the in-app checklist: location set to Allow for the site,
Auto-Lock off if iOS is older than 18.4, ringer not on silent, phone on the mount and charging,
Google Maps on CarPlay / Android Auto for turn-by-turn, tap Start and listen for the chime.
