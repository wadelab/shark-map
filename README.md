# Shark Map

A static web page that maps where sharks have been recorded around the world. The browser
queries the [OBIS](https://obis.org) occurrence API directly, so there is no server and the
site runs on GitHub Pages.

Live site: <https://wadelab.github.io/shark-map/>

## What it shows

- **Individual records.** Up to 20,000 occurrence records for the chosen species, coloured by
  record type: tag or receiver detections, sightings and catches, and specimens or other
  records. Click a dot for the date, position and source dataset.
- **Density of all records.** Every matching record counted into geohash cells of about
  150 km, from the OBIS grid endpoint.
- Filters for species and year range. The current view is kept in the URL, so links are
  shareable.
- A CSV download of the plotted records.
- A version tag in the panel footer, such as `v0.1.0+1a2b3c4`, naming the release and commit
  that built the page.

## Caveats about the data

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

## Third-party pieces

- [Leaflet](https://leafletjs.com) 1.9.4, vendored in `vendor/leaflet/`, BSD-2-Clause.
- Basemap tiles from [CARTO](https://carto.com/attributions), built on OpenStreetMap data.
  CARTO's free basemaps have usage terms. Check them if traffic grows, or change the tile URL
  in `app.js`.
- Records from the [Ocean Biodiversity Information System](https://obis.org).
