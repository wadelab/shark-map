// Browser smoke test for Shark Map.
//   node tests/smoke.mjs          mocked OBIS API (works offline)
//   LIVE=1 node tests/smoke.mjs   real OBIS API, checks CORS and response shape
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE = process.env.SITE_DIR ? resolve(process.env.SITE_DIR) : ROOT;
const LIVE = process.env.LIVE === '1';
const SHOTS = join(ROOT, 'test-results');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.txt': 'text/plain' };

// ---------- static server ----------
function serve() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(SITE, path === '/' ? 'index.html' : path));
    if (!file.startsWith(SITE + sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// ---------- mock OBIS ----------
const TOTALS = { 'Carcharodon carcharias': 12000, 'Rhincodon typus': 0 };
const HOTSPOTS = [[-34.5, 19.5], [-35, 137], [36.5, -122.5], [41.5, -70], [37, 15], [-28, 153.5], [21, -157], [24, -110]];
const BASIS = ['MachineObservation', 'MachineObservation', 'HumanObservation', 'HumanObservation', 'HumanObservation', 'PreservedSpecimen', 'Occurrence'];
const DATASET = '78bf6b7f-555c-4bf7-8d81-a766c5bc736e';

function rand(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

function mockRecord(i) {
  const r = rand(i * 7919 + 13);
  const [lat, lon] = HOTSPOTS[i % HOTSPOTS.length];
  const rec = {
    id: `rec-${String(i).padStart(6, '0')}`,
    decimalLatitude: +(lat + (r() - 0.5) * 8).toFixed(4),
    decimalLongitude: +(lon + (r() - 0.5) * 10).toFixed(4),
    eventDate: `${1990 + (i % 35)}-0${1 + (i % 9)}-1${i % 9}`,
    date_year: 1990 + (i % 35),
    basisOfRecord: BASIS[i % BASIS.length],
    scientificName: 'Carcharodon carcharias',
    dataset_id: i % 2 ? DATASET : 'not-a-uuid',
    institutionCode: i === 2 ? '=HYPERLINK("http://evil")' : 'TEST',
  };
  if (i === 1) rec.scientificName = '<img src=x onerror="window.__xss=1">';
  if (i === 3) rec.eventDate = '<img src=x onerror="window.__xss=2">';
  if (i % 997 === 5) rec.decimalLatitude = 123; // invalid, must be skipped
  if (i % 1499 === 7) rec.decimalLongitude = null;
  return rec;
}

function mockOccurrence(url) {
  const p = url.searchParams;
  const total = TOTALS[p.get('scientificname')] ?? 3000;
  const size = Number(p.get('size'));
  const start = p.get('after') ? Number(p.get('after').slice(4)) + 1 : 0;
  const end = Math.min(total, start + size);
  const results = [];
  for (let i = start; i < end; i += 1) results.push(mockRecord(i));
  return { total, results };
}

function mockGrid(url) {
  const total = TOTALS[url.searchParams.get('scientificname')] ?? 3000;
  if (!total) return { type: 'FeatureCollection', features: [] };
  const features = [];
  const step = 1.40625;
  HOTSPOTS.forEach(([lat, lon], h) => {
    for (let a = -3; a <= 3; a += 1) {
      for (let b = -3; b <= 3; b += 1) {
        const n = Math.max(1, Math.round(4000 / (1 + (a * a + b * b) ** 1.6) / (1 + h)));
        const y = Math.floor(lat / step + a) * step;
        const x = Math.floor(lon / step + b) * step;
        features.push({
          type: 'Feature',
          properties: { n },
          geometry: { type: 'Polygon', coordinates: [[[x, y], [x + step, y], [x + step, y + step], [x, y + step], [x, y]]] },
        });
      }
    }
  });
  return { type: 'FeatureCollection', features };
}

// Plain one-colour PNG tiles so the page renders without the basemap host.
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function png(r, g, b) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, r, g, b]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const TILE = png(0xd4, 0xda, 0xdc);
const TILE_DARK = png(0x26, 0x26, 0x26);

async function newPage(browser, base, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 800 }, colorScheme: opts.colorScheme || 'light' });
  const page = await ctx.newPage();
  const log = { requests: [], errors: [] };
  page.on('pageerror', (e) => log.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/tile|cartocdn|favicon/i.test(m.text())) log.errors.push(m.text()); });
  if (!LIVE) {
    await ctx.route(/basemaps\.cartocdn\.com/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: opts.colorScheme === 'dark' ? TILE_DARK : TILE }));
    await ctx.route(/api\.obis\.org/, async (route) => {
      const url = new URL(route.request().url());
      log.requests.push(url);
      if (opts.fail) { await route.fulfill({ status: 500, body: 'boom' }); return; }
      const body = url.pathname.includes('/occurrence/grid/') ? mockGrid(url) : mockOccurrence(url);
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    });
  }
  await page.goto(`${base}/${opts.hash ? `#${opts.hash}` : ''}`);
  await waitIdle(page);
  return { page, ctx, log };
}

async function waitIdle(page) {
  await page.waitForFunction(() => window.sharkMap && !window.sharkMap.state.loading, null, { timeout: LIVE ? 120000 : 15000 });
}

const state = (page) => page.evaluate(() => {
  const { records, grid, ...rest } = window.sharkMap.state;
  return rest;
});
const text = (page, sel) => page.locator(sel).innerText();

// ---------- tests ----------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('default view plots a capped subset with skipped bad coordinates', async (b, base) => {
  const { page, log, ctx } = await newPage(b, base);
  const s = await state(page);
  assert.equal(s.view, 'points');
  assert.equal(s.total, 12000);
  assert.ok(s.skipped >= 2, `skipped ${s.skipped}`);
  assert.equal(s.plotted + s.skipped, 5000);
  const status = await text(page, '#status');
  assert.match(status, /^Showing 4,99\d of 12,000 White shark records, an arbitrary subset\. \d+ without valid coordinates were skipped\.$/);
  assert.equal(log.requests.length, 1);
  const p = log.requests[0].searchParams;
  assert.equal(p.get('scientificname'), 'Carcharodon carcharias');
  assert.equal(p.get('size'), '5000');
  assert.ok(p.get('fields').split(',').includes('id'));
  assert.equal(p.get('after'), null);
  const rows = await page.locator('#legend tr').count();
  assert.equal(rows, 3);
  const sum = await page.$$eval('#legend td.num', (tds) => tds.reduce((a, td) => a + Number(td.textContent.replace(/,/g, '')), 0));
  assert.equal(sum, s.plotted);
  const version = await text(page, '#version');
  if (process.env.SITE_DIR) assert.match(version, /^v\d+\.\d+\.\d+\+[0-9a-f]{7}$/);
  else assert.equal(version, 'dev build');
  assert.match(page.url(), /#species=Carcharodon\+carcharias&view=points&limit=5000$/);
  assert.deepEqual(log.errors, []);
  await page.screenshot({ path: join(SHOTS, 'desktop-points.png') });
  await ctx.close();
});

test('paging follows the after cursor up to the limit', async (b, base) => {
  const { page, log, ctx } = await newPage(b, base, { hash: 'species=Carcharodon+carcharias&limit=10000' });
  assert.equal(log.requests.length, 2);
  assert.equal(log.requests[1].searchParams.get('after'), 'rec-004999');
  const s = await state(page);
  assert.equal(s.plotted + s.skipped, 10000);
  await ctx.close();
});

test('small species loads fully without a subset note', async (b, base) => {
  const { page, log, ctx } = await newPage(b, base, { hash: 'species=Galeocerdo+cuvier&limit=5000' });
  assert.equal(log.requests.length, 1);
  assert.match(await text(page, '#status'), /^Showing 2,99\d of 3,000 Tiger shark records\./);
  assert.doesNotMatch(await text(page, '#status'), /subset/);
  await ctx.close();
});

test('year range becomes start and end dates and is reordered when reversed', async (b, base) => {
  const { log, ctx } = await newPage(b, base, { hash: 'species=Carcharodon+carcharias&from=2010&to=2000' });
  const p = log.requests[0].searchParams;
  assert.equal(p.get('startdate'), '2000-01-01');
  assert.equal(p.get('enddate'), '2010-12-31');
  await ctx.close();
});

test('hash values outside the allowlists fall back to defaults', async (b, base) => {
  const { page, log, ctx } = await newPage(b, base, { hash: 'species=%3Cscript%3E&limit=999999&view=evil&from=abc' });
  const p = log.requests[0].searchParams;
  assert.equal(p.get('scientificname'), 'Carcharodon carcharias');
  assert.equal(p.get('size'), '5000');
  assert.equal(p.get('startdate'), null);
  assert.equal((await state(page)).view, 'points');
  await ctx.close();
});

test('popups and hover tooltips render record text safely; links only for valid dataset ids', async (b, base) => {
  const { page, ctx } = await newPage(b, base);
  const open = (id) => page.evaluate((recId) => {
    const { map } = window.sharkMap;
    let target = null;
    map.eachLayer((l) => { if (l.rec && l.rec.id === recId) target = l; });
    target.fire('click', { latlng: target.getLatLng() }, true);
    const all = document.querySelectorAll('.leaflet-popup-content');
    return all[all.length - 1].innerHTML;
  }, id);
  const html1 = await open('rec-000001');
  assert.ok(html1.includes('&lt;img'), html1);
  assert.equal(await page.locator('.leaflet-popup-content img').count(), 0);
  assert.ok(html1.includes('href="https://obis.org/dataset/78bf6b7f-555c-4bf7-8d81-a766c5bc736e"'));
  const html0 = await open('rec-000000');
  assert.ok(!html0.includes('href='), 'no link for an invalid dataset id');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  const tip = await page.evaluate(() => {
    const { map } = window.sharkMap;
    let target = null;
    map.eachLayer((l) => { if (l.rec && l.rec.id === 'rec-000003') target = l; });
    target.fire('mouseover', { latlng: target.getLatLng() }, true);
    return document.querySelector('.leaflet-tooltip').innerHTML;
  });
  assert.ok(tip.includes('&lt;img'), tip);
  assert.equal(await page.locator('.leaflet-tooltip img').count(), 0);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await ctx.close();
});

test('CSV download escapes formulas and quotes', async (b, base) => {
  const { page, ctx } = await newPage(b, base);
  assert.equal(await page.locator('#download-row').isVisible(), true);
  const csv = await page.evaluate(async () => (await fetch(document.getElementById('download').href)).text());
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'id,scientificName,decimalLatitude,decimalLongitude,eventDate,basisOfRecord,institutionCode,dataset_id');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), 'formula cell neutralised');
  assert.match(lines[1], /^"rec-000000","Carcharodon carcharias",-?\d/);
  await ctx.close();
});

test('density view requests the grid and summarises all records', async (b, base) => {
  const { page, log, ctx } = await newPage(b, base, { hash: 'species=Carcharodon+carcharias&view=density' });
  assert.equal(log.requests.length, 1);
  assert.equal(log.requests[0].pathname, '/v3/occurrence/grid/3');
  const s = await state(page);
  assert.equal(s.cells, 8 * 49);
  assert.ok(s.total > 0);
  assert.match(await text(page, '#status'), /^Density of [\d,]+ White shark records in 392 cells of about 150 km\.$/);
  assert.ok(await page.locator('#legend tr').count() >= 3);
  assert.equal(await page.locator('#limit-row').isVisible(), false);
  assert.equal(await page.locator('#download-row').isVisible(), false);
  await page.screenshot({ path: join(SHOTS, 'desktop-density.png') });
  await ctx.close();
});

test('switching view from the form updates the map and the URL', async (b, base) => {
  const { page, log, ctx } = await newPage(b, base);
  await page.locator('input[name="view"][value="density"]').check();
  await page.waitForFunction(() => window.sharkMap.state.view === 'density' && !window.sharkMap.state.loading);
  assert.match(page.url(), /view=density/);
  assert.equal(log.requests.at(-1).pathname, '/v3/occurrence/grid/3');
  await page.selectOption('#species', 'Galeocerdo cuvier');
  await page.waitForFunction(() => window.sharkMap.state.species === 'Galeocerdo cuvier' && !window.sharkMap.state.loading);
  assert.equal(log.requests.at(-1).searchParams.get('scientificname'), 'Galeocerdo cuvier');
  await ctx.close();
});

test('no records gives a clear message', async (b, base) => {
  const { page, ctx } = await newPage(b, base, { hash: 'species=Rhincodon+typus' });
  assert.equal(await text(page, '#status'), 'No records match these filters.');
  assert.equal(await page.locator('#download-row').isVisible(), false);
  await ctx.close();
});

test('API failure shows an error and no data', async (b, base) => {
  const { page, ctx } = await newPage(b, base, { fail: true });
  assert.equal(await page.locator('#error').isVisible(), true);
  assert.match(await text(page, '#error'), /HTTP 500/);
  const s = await state(page);
  assert.equal(s.plotted, 0);
  assert.equal(await page.locator('#download-row').isVisible(), false);
  await ctx.close();
});

test('phone layout and dark theme render', async (b, base) => {
  const phone = await newPage(b, base, { viewport: { width: 390, height: 844 } });
  const box = await phone.page.locator('#panel').boundingBox();
  assert.ok(box.width <= 390 && box.x >= 0, JSON.stringify(box));
  const scrollW = await phone.page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(scrollW <= 390, `horizontal scroll ${scrollW}`);
  const attr = await phone.page.locator('.leaflet-control-attribution').boundingBox();
  const panel = await phone.page.locator('#panel').boundingBox();
  assert.ok(attr.y + attr.height <= panel.y, 'attribution hidden behind the panel');
  const zoom = await phone.page.locator('.leaflet-control-zoom').boundingBox();
  const overlap = !(zoom.x + zoom.width <= attr.x || attr.x + attr.width <= zoom.x || zoom.y + zoom.height <= attr.y || attr.y + attr.height <= zoom.y);
  assert.ok(!overlap, 'attribution overlaps the zoom control');
  assert.equal(await phone.page.locator('#controls').isVisible(), false, 'filters start collapsed on phones');
  assert.equal(await phone.page.locator('#status').isVisible(), true);
  await phone.page.screenshot({ path: join(SHOTS, 'phone.png') });
  await phone.page.click('#panel-toggle');
  assert.equal(await phone.page.locator('#controls').isVisible(), true);
  assert.equal(await phone.page.getAttribute('#panel-toggle', 'aria-expanded'), 'true');
  await phone.page.screenshot({ path: join(SHOTS, 'phone-open.png') });
  await phone.ctx.close();
  const dark = await newPage(b, base, { colorScheme: 'dark' });
  const bg = await dark.page.evaluate(() => getComputedStyle(document.getElementById('panel')).backgroundColor);
  assert.equal(bg, 'rgb(26, 26, 25)');
  await dark.page.screenshot({ path: join(SHOTS, 'desktop-dark.png') });
  await dark.ctx.close();
});

// Live checks run against the real API from CI.
const liveTests = [
  ['live: points load from OBIS', async (b, base) => {
    const { page, log, ctx } = await newPage(b, base, { hash: 'species=Carcharodon+carcharias&limit=1000' });
    const s = await state(page);
    console.log('  status:', await text(page, '#status'));
    const first = await page.evaluate(() => window.sharkMap.state.records[0]);
    console.log('  first record keys:', Object.keys(first || {}).join(','));
    assert.equal(s.error, null, s.error);
    assert.ok(s.plotted > 0, 'no records plotted');
    assert.ok(s.total >= s.plotted);
    assert.deepEqual(log.errors, []);
    await page.screenshot({ path: join(SHOTS, 'live-points.png') });
    await ctx.close();
  }],
  ['live: density grid loads with counts', async (b, base) => {
    const { page, ctx } = await newPage(b, base, { hash: 'species=Carcharodon+carcharias&view=density' });
    const s = await state(page);
    console.log('  status:', await text(page, '#status'));
    const props = await page.evaluate(() => window.sharkMap.state.grid && window.sharkMap.state.grid.features[0] && window.sharkMap.state.grid.features[0].properties);
    console.log('  first cell properties:', JSON.stringify(props));
    assert.equal(s.error, null, s.error);
    assert.ok(s.cells > 0, 'no grid cells');
    assert.ok(s.total > 0, 'grid cells carry no recognised count property');
    await page.screenshot({ path: join(SHOTS, 'live-density.png') });
    await ctx.close();
  }],
];

// ---------- runner ----------
await mkdir(SHOTS, { recursive: true });
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const launch = { headless: true };
if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launch);
const run = LIVE ? liveTests.map(([name, fn]) => ({ name, fn })) : tests;
let failed = 0;
for (const t of run) {
  try {
    await t.fn(browser, base);
    console.log(`ok   ${t.name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${String(err && err.stack || err).split('\n').slice(0, 4).join('\n     ')}`);
  }
}
await browser.close();
server.close();
console.log(`\n${run.length - failed}/${run.length} passed${LIVE ? ' (live OBIS)' : ' (mocked OBIS)'}`);
process.exit(failed ? 1 : 0);
