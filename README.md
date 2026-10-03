# Shark Map · Carte des requins

A static web page that maps where sharks have been recorded around the world. The browser
queries the [OBIS](https://obis.org) occurrence API directly, so there is no server and the
site runs on GitHub Pages.

Live site: <https://wadelab.github.io/shark-map/>

## What it shows

The map opens on Nova Scotia and its surrounding waters. The maple leaf button under the zoom
controls returns there. If a search finds nothing in view, the map moves to the records, and
otherwise it keeps your view.

- **Individual records.** Up to 20,000 occurrence records for the chosen species, coloured by
  record type: tag or receiver detections, sightings and catches, and specimens or other
  records. Click a dot for the date, position and source dataset.
- **Density of all records.** Every matching record counted into geohash cells of about
  150 km, from the OBIS grid endpoint.
- Filters for species and time range. The time range starts at the last 12 months, with
  presets for the last 5 years and all years, or a custom range of years. The current view is
  kept in the URL, so links are shareable.
- Records often reach OBIS months or years after collection, so recent periods can look
  sparse. When a rolling period finds nothing, the page says so and suggests a longer range.
- A CSV download of the plotted records.
- A version tag in the panel footer, such as `v0.1.0+1a2b3c4`, naming the release and commit
  that built the page.

## Caveats about the data

- Record types come from each record's sampling method when OBIS has one, and otherwise from
  its basis of record. The method wins because some eDNA samples are filed as machine
  observations and some satellite-tag datasets as human observations.
- Tag data are scarce in recent periods. In October 2026 the newest white shark tag record in
  OBIS dated from December 2022, and OBIS held no white shark tag data off Nova Scotia at all.
  The legend says when none of the plotted records come from tags.

- These are occurrence records, not live positions. Most are historical. Researchers who tag
  sharks often delay or coarsen positions before sharing them.
- OBIS returns records in no particular order. When a species has more records than the
  plotting limit, the dots are an arbitrary subset. The density view always counts everything.
- Records come from many datasets, each with its own licence and citation. Follow the dataset
  link in a record's popup before reusing data.
- Live tracker feeds such as OCEARCH have no public API and are not included.

## Run locally

Any static file server works:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Tests

The browser tests use Playwright with headless Chromium.

```bash
npm ci
npx playwright install chromium   # skip if Chromium is already installed
npm test                          # mocked OBIS API, works offline
npm run test:live                 # real OBIS API
```

The mocked suite covers paging, filters, URL validation, safe rendering of record text, CSV
escaping, the density view, error handling and the phone layout. The live suite checks that
the real API answers a cross-origin browser request and still returns the fields the page
reads.

## Deployment

`.github/workflows/pages.yml` runs on every push to `main`:

1. Builds the site into `_site/` with `scripts/build.sh`, which stamps the version, and runs
   the mocked browser tests against that build.
2. Runs the live OBIS check in parallel. This does not block deployment, but a failure means
   the live site is likely broken.
3. Uploads `_site/` and deploys it to GitHub Pages.

One-time setup: in the repository settings, open **Pages** and set **Source** to
**GitHub Actions**.

To cut a release, bump `VERSION`. Every build also appends the short commit SHA.

## Optional CARTO basemap

Since late August 2026 CARTO's basemap tiles need an API key. Without one, every tile carries
an "API KEY REQUIRED" watermark, so the site uses OpenStreetMap tiles unless a key is set.

To switch to CARTO's light and dark styles:

1. Request a free key at <https://carto.com/basemaps/apikey>. It is emailed to you, and no
   account is needed.
2. Restrict the key to `wadelab.github.io` in CARTO's dashboard. The key is visible in the
   page source, so the restriction is what stops other sites using it.
3. In this repository, open **Settings**, then **Secrets and variables**, then **Actions**, then
   the **Variables** tab. Add a repository variable named `CARTO_BASEMAP_KEY` with the key.
4. Re-run the workflow, or push a commit. The build log names the basemap it used.

The build keeps only letters, digits, `-` and `_` from the key.

## Look and feel

The styling is Canadian: a flag-red header with a white maple leaf, a bilingual English and
French title, and red buttons and links. It deliberately avoids Government of Canada branding,
such as the Canada wordmark or the federal identity header, so it can't be mistaken for an
official site. The data colours are unchanged, because they are chosen to stay distinguishable
for colour-blind readers.

## Third-party pieces

- Maple leaf outline from the flag of Canada, taken from
  [flag-icons](https://github.com/lipis/flag-icons), MIT licence.
- [Leaflet](https://leafletjs.com) 1.9.4, vendored in `vendor/leaflet/`, BSD-2-Clause.
- Basemap tiles from [OpenStreetMap](https://www.openstreetmap.org/copyright) by default. They
  need no key, but the OpenStreetMap Foundation's tile policy only allows light use and requires
  the attribution to stay visible. The page mutes their colours, and inverts them in dark mode.
- Optional [CARTO](https://carto.com/attributions) basemaps, see below.
- Records from the [Ocean Biodiversity Information System](https://obis.org).
