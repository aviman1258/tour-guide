# Deodapper — Self-Guided Tour Creator

Named for Deodap, an elephant Avishek met; a cartoon of him (`web/img/deodap.svg`, with his
speckled ears and a garland) is the logo, and the PNG icons are rendered from it.
Live at https://deodapper.com.

Plan a self-drive day between an airport (or wherever you are) and your hotel, built around
what you're into, timed to your check-in, drawn on a map. Then take it in the car: an
installable web app that follows you by GPS and narrates each stop, plus the interesting
things you pass on the way, through the phone's own text-to-speech.

Personal project. First trip: Houston, November 2026.

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
server treats as the subscriber tier. **Free** (`plan.html?tier=free`) hides every AI control and
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

Later: real accounts + Stripe replace the passphrase; the tier check is the one place to change.

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
   2:00 (ties go to the one nearest 12:30) and gets an hour.
5. **Trimming**: while there are 6+ stops, the lowest-priority stop is cut. Below that,
   stays are shortened toward sensible minimums first (low-priority stops give up their
   time first, lunch keeps 45 min) because several quick stops beat two long ones; only
   then are more stops cut. Once OSRM's real timings come back, the best cut stop is added
   back if there's 20+ min to spare. Cut stops show under "Didn't fit" with *Add back*.

Edits (reorder, remove, add by search, tap the map, "Suggest more", lunch toggle, dwell) all
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
| `GET /api/health` | | `{ok, claude:"sdk"\|"cli", models, osrm}` |
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
- **Next-turn banner** from OSRM steps (fallback for cars without CarPlay). "Speak turns" is
  off by default because the car's Google Maps does that better.

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

Point your domain at the service (Cloudflare CNAME → the `onrender.com` host, then add the custom
domain in Render for the certificate). Install the PWA from that domain; planning, prepare-drive
and drive mode all work from the phone. The browser also keeps its own history of run times
(`web/js/timings.js`), so estimates survive redeploys and host changes regardless.

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
