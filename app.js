/* Shark Map: plots shark occurrence records from the OBIS API (https://api.obis.org). */
'use strict';

(() => {
  const API = 'https://api.obis.org/v3';
  const PAGE_SIZE = 5000;
  const REQUEST_TIMEOUT_MS = 45000;
  const GRID_PRECISION = 3; // geohash precision 3 is roughly 156 km x 156 km at the equator
  const FIELDS = [
    'id', 'decimalLatitude', 'decimalLongitude', 'eventDate', 'date_year',
    'basisOfRecord', 'scientificName', 'dataset_id', 'institutionCode',
  ];
  const LIMITS = [1000, 5000, 10000, 20000];
  const VIEWS = ['points', 'density'];
  const MIN_YEAR = 1700;
  const MAX_YEAR = new Date().getFullYear() + 1;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Accepted WoRMS names. OBIS resolves each name to its taxon.
  const SPECIES = [
    { name: 'Cetorhinus maximus', common: 'Basking shark' },
    { name: 'Carcharhinus melanopterus', common: 'Blacktip reef shark' },
    { name: 'Prionace glauca', common: 'Blue shark' },
    { name: 'Carcharhinus leucas', common: 'Bull shark' },
    { name: 'Sphyrna mokarran', common: 'Great hammerhead' },
    { name: 'Somniosus microcephalus', common: 'Greenland shark' },
    { name: 'Negaprion brevirostris', common: 'Lemon shark' },
    { name: 'Ginglymostoma cirratum', common: 'Nurse shark' },
    { name: 'Carcharhinus longimanus', common: 'Oceanic whitetip shark' },
    { name: 'Lamna nasus', common: 'Porbeagle' },
    { name: 'Sphyrna lewini', common: 'Scalloped hammerhead' },
    { name: 'Isurus oxyrinchus', common: 'Shortfin mako' },
    { name: 'Carcharhinus falciformis', common: 'Silky shark' },
    { name: 'Galeocerdo cuvier', common: 'Tiger shark' },
    { name: 'Rhincodon typus', common: 'Whale shark' },
    { name: 'Carcharodon carcharias', common: 'White shark' },
  ];
  const DEFAULT_SPECIES = 'Carcharodon carcharias';

  // Three categorical slots, validated all-pairs for colour-vision deficiency in both themes.
  const CATEGORIES = [
    { key: 'machine', label: 'Tag or receiver detection', light: '#2a78d6', dark: '#3987e5' },
    { key: 'human', label: 'Sighting, survey or catch', light: '#eb6834', dark: '#d95926' },
    { key: 'other', label: 'Specimen or other record', light: '#1baf7a', dark: '#199e70' },
  ];

  // Sequential blue ramp for record density, light-to-dark in light mode and reversed in dark mode.
  const DENSITY_BREAKS = [1, 10, 100, 1000, 10000, 100000];
  const DENSITY_RAMP = ['#b7d3f6', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'];

  const TILES = {
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  };
  const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors '
    + '&copy; <a href="https://carto.com/attributions">CARTO</a> | Records: <a href="https://obis.org">OBIS</a>';

  const $ = (id) => document.getElementById(id);
  const ui = {
    form: $('controls'), species: $('species'), from: $('from'), to: $('to'), limit: $('limit'),
    limitRow: $('limit-row'), load: $('load'), status: $('status'), error: $('error'),
    legend: $('legend'), downloadRow: $('download-row'), download: $('download'),
    version: $('version'), panel: $('panel'), toggle: $('panel-toggle'),
  };

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const narrow = window.matchMedia('(max-width: 640px)').matches;
  const theme = () => (darkQuery.matches ? 'dark' : 'light');
  const nf = new Intl.NumberFormat('en');

  const state = {
    view: 'points', loading: false, plotted: 0, total: 0, skipped: 0, cells: 0,
    species: DEFAULT_SPECIES, records: [], grid: null, error: null,
  };

  // ---------- Map ----------
  const map = L.map('map', {
    worldCopyJump: true,
    minZoom: narrow ? 1 : 2,
    maxZoom: 10,
    zoomSnap: 0.5,
    renderer: L.canvas({ tolerance: 6, padding: 0.5 }),
  }).setView([15, 0], narrow ? 1 : 2);
  // On phones the control panel is a bottom sheet, so keep the attribution clear of it.
  if (narrow) {
    map.zoomControl.setPosition('topright');
    map.attributionControl.setPosition('topright');
  }

  let tiles = null;
  function setTiles() {
    if (tiles) map.removeLayer(tiles);
    tiles = L.tileLayer(TILES[theme()], {
      subdomains: 'abcd', maxZoom: 19, attribution: ATTRIBUTION, crossOrigin: true,
    }).addTo(map);
  }
  setTiles();

  const dataLayer = L.featureGroup().addTo(map);
  const hoverTip = L.tooltip({ direction: 'top', offset: [0, -6], opacity: 1 });

  // ---------- Helpers ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function categoryOf(basis) {
    const b = String(basis || '').toLowerCase().replace(/[^a-z]/g, '');
    if (b === 'machineobservation') return CATEGORIES[0];
    if (b === 'humanobservation') return CATEGORIES[1];
    return CATEGORIES[2];
  }

  function colourFor(category) {
    return category[theme()];
  }

  function surfaceRing() {
    return theme() === 'dark' ? '#1a1a19' : '#ffffff';
  }

  function densityColour(n) {
    const ramp = theme() === 'dark' ? [...DENSITY_RAMP].reverse() : DENSITY_RAMP;
    let i = 0;
    while (i < DENSITY_BREAKS.length - 1 && n >= DENSITY_BREAKS[i + 1]) i += 1;
    return ramp[i];
  }

  function cellCount(props) {
    if (!props) return 0;
    for (const key of ['n', 'count', 'records', 'total']) {
      if (props[key] !== null && props[key] !== undefined && Number.isFinite(Number(props[key]))) {
        return Number(props[key]);
      }
    }
    return 0;
  }

  function validCoord(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  function speciesLabel(name) {
    const s = SPECIES.find((x) => x.name === name);
    return s ? s.common : name;
  }

  function recordDate(rec) {
    if (typeof rec.eventDate === 'string' && rec.eventDate) return rec.eventDate.slice(0, 40);
    if (Number.isFinite(Number(rec.date_year))) return String(rec.date_year);
    return 'Unknown';
  }

  // ---------- Query state (form <-> URL hash) ----------
  function parseYear(value) {
    if (value === null || value === undefined || value === '') return null;
    const y = Number(value);
    return Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR ? y : null;
  }

  function readQuery(source) {
    const q = {
      species: source.get('species'),
      from: parseYear(source.get('from')),
      to: parseYear(source.get('to')),
      view: source.get('view'),
      limit: Number(source.get('limit')),
    };
    if (!SPECIES.some((s) => s.name === q.species)) q.species = DEFAULT_SPECIES;
    if (!VIEWS.includes(q.view)) q.view = 'points';
    if (!LIMITS.includes(q.limit)) q.limit = 5000;
    if (q.from !== null && q.to !== null && q.from > q.to) [q.from, q.to] = [q.to, q.from];
    return q;
  }

  function queryFromHash() {
    return readQuery(new URLSearchParams(window.location.hash.replace(/^#/, '')));
  }

  function queryFromForm() {
    return readQuery(new FormData(ui.form));
  }

  function applyQueryToForm(q) {
    ui.species.value = q.species;
    ui.from.value = q.from ?? '';
    ui.to.value = q.to ?? '';
    ui.limit.value = String(q.limit);
    ui.form.querySelector(`input[name="view"][value="${q.view}"]`).checked = true;
    ui.limitRow.hidden = q.view !== 'points';
  }

  function writeHash(q) {
    const p = new URLSearchParams();
    p.set('species', q.species);
    if (q.from !== null) p.set('from', String(q.from));
    if (q.to !== null) p.set('to', String(q.to));
    p.set('view', q.view);
    if (q.view === 'points') p.set('limit', String(q.limit));
    history.replaceState(null, '', `#${p.toString()}`);
  }

  function apiParams(q) {
    const p = new URLSearchParams();
    p.set('scientificname', q.species);
    if (q.from !== null) p.set('startdate', `${q.from}-01-01`);
    if (q.to !== null) p.set('enddate', `${q.to}-12-31`);
    return p;
  }

  // ---------- Network ----------
  async function fetchJSON(url, outerSignal) {
    const local = new AbortController();
    const onAbort = () => local.abort(outerSignal.reason);
    if (outerSignal.aborted) local.abort(outerSignal.reason);
    outerSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => local.abort(new Error('timeout')), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: local.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`OBIS returned HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (outerSignal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (local.signal.aborted) throw new Error('OBIS did not respond in time');
      throw err;
    } finally {
      clearTimeout(timer);
      outerSignal.removeEventListener('abort', onAbort);
    }
  }

  // ---------- Rendering ----------
  function popupContent(rec) {
    const root = el('div', 'rec');
    root.append(el('div', 'name', rec.scientificName || state.species));
    const dl = el('dl');
    const row = (label, value) => {
      dl.append(el('dt', null, label));
      const dd = el('dd');
      if (value instanceof Node) dd.append(value); else dd.textContent = value;
      dl.append(dd);
    };
    const cat = categoryOf(rec.basisOfRecord);
    row('Date', recordDate(rec));
    row('Type', rec.basisOfRecord ? `${cat.label} (${rec.basisOfRecord})` : cat.label);
    row('Position', `${rec.decimalLatitude.toFixed(3)}, ${rec.decimalLongitude.toFixed(3)}`);
    if (rec.institutionCode) row('Institution', String(rec.institutionCode).slice(0, 80));
    if (typeof rec.dataset_id === 'string' && UUID_RE.test(rec.dataset_id)) {
      const a = el('a', null, 'View on OBIS');
      a.href = `https://obis.org/dataset/${rec.dataset_id}`;
      a.target = '_blank';
      a.rel = 'noopener';
      row('Dataset', a);
    }
    root.append(dl);
    return root;
  }

  function addPoints(records) {
    for (const rec of records) {
      const cat = categoryOf(rec.basisOfRecord);
      const m = L.circleMarker([rec.decimalLatitude, rec.decimalLongitude], {
        radius: 4,
        weight: 1,
        color: surfaceRing(),
        opacity: 0.9,
        fillColor: colourFor(cat),
        fillOpacity: 0.9,
      });
      m.rec = rec;
      m.addTo(dataLayer);
    }
  }

  function renderGrid(geojson) {
    L.geoJSON(geojson, {
      style: (f) => ({
        fillColor: densityColour(cellCount(f.properties)),
        fillOpacity: 0.8,
        color: surfaceRing(),
        weight: 0.5,
        opacity: 0.6,
      }),
      pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 5 }),
      onEachFeature: (f, layer) => { layer.cellCount = cellCount(f.properties); },
    }).eachLayer((layer) => layer.addTo(dataLayer));
  }

  function redraw() {
    dataLayer.clearLayers();
    if (state.view === 'points') addPoints(state.records);
    else if (state.grid) renderGrid(state.grid);
    renderLegend();
  }

  function renderLegend() {
    ui.legend.replaceChildren();
    const table = el('table');
    if (state.view === 'points') {
      if (!state.plotted) return;
      table.append(el('caption', null, 'Record type'));
      const counts = new Map(CATEGORIES.map((c) => [c.key, 0]));
      for (const rec of state.records) {
        const key = categoryOf(rec.basisOfRecord).key;
        counts.set(key, counts.get(key) + 1);
      }
      for (const cat of CATEGORIES) {
        const tr = el('tr');
        const label = el('td');
        const sw = el('span', 'swatch');
        sw.style.background = colourFor(cat);
        label.append(sw, document.createTextNode(cat.label));
        tr.append(label, el('td', 'num', nf.format(counts.get(cat.key))));
        table.append(tr);
      }
    } else {
      if (!state.cells) return;
      table.append(el('caption', null, 'Records per cell (number of cells)'));
      const binCells = DENSITY_BREAKS.map(() => 0);
      for (const f of state.grid.features) {
        const n = cellCount(f.properties);
        let i = 0;
        while (i < DENSITY_BREAKS.length - 1 && n >= DENSITY_BREAKS[i + 1]) i += 1;
        binCells[i] += 1;
      }
      const lastBin = binCells.reduce((last, c, i) => (c ? i : last), 0);
      DENSITY_BREAKS.forEach((lo, i) => {
        if (i > lastBin) return;
        const hi = DENSITY_BREAKS[i + 1];
        const tr = el('tr');
        const label = el('td');
        const sw = el('span', 'swatch square');
        sw.style.background = densityColour(lo);
        const text = hi ? `${nf.format(lo)} to ${nf.format(hi - 1)}` : `${nf.format(lo)} or more`;
        label.append(sw, document.createTextNode(text));
        tr.append(label, el('td', 'num', nf.format(binCells[i])));
        table.append(tr);
      });
    }
    ui.legend.append(table);
  }

  dataLayer.on('mouseover', (e) => {
    const layer = e.layer;
    let text;
    if (layer.rec) {
      text = `${categoryOf(layer.rec.basisOfRecord).label} · ${recordDate(layer.rec)}`;
    } else if (layer.cellCount !== undefined) {
      text = `${nf.format(layer.cellCount)} record${layer.cellCount === 1 ? '' : 's'} in this cell`;
    }
    if (!text) return;
    // Leaflet renders string content as HTML, so pass a text node: record fields are untrusted.
    hoverTip.setLatLng(e.latlng).setContent(el('span', null, text));
    map.openTooltip(hoverTip);
  });
  dataLayer.on('mouseout', () => map.closeTooltip(hoverTip));
  dataLayer.on('click', (e) => {
    if (!e.layer.rec) return;
    L.popup({ maxWidth: 280 }).setLatLng(e.latlng).setContent(popupContent(e.layer.rec)).openOn(map);
  });

  // ---------- Status, errors, download ----------
  function setStatus(text) { ui.status.textContent = text; }

  function showError(message) {
    state.error = message;
    ui.error.textContent = message;
    ui.error.hidden = false;
  }

  function clearError() {
    state.error = null;
    ui.error.hidden = true;
    ui.error.textContent = '';
  }

  let downloadUrl = null;
  function csvCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return String(value);
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets treating text as a formula
    return `"${s.replace(/"/g, '""')}"`;
  }

  function updateDownload() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    if (state.view !== 'points' || !state.records.length) {
      ui.downloadRow.hidden = true;
      return;
    }
    const cols = ['id', 'scientificName', 'decimalLatitude', 'decimalLongitude', 'eventDate', 'basisOfRecord', 'institutionCode', 'dataset_id'];
    const lines = [cols.join(',')];
    for (const rec of state.records) lines.push(cols.map((c) => csvCell(rec[c])).join(','));
    downloadUrl = URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }));
    ui.download.href = downloadUrl;
    ui.download.download = `${state.species.replace(/\s+/g, '_')}_obis_records.csv`;
    ui.downloadRow.hidden = false;
  }

  // ---------- Loading ----------
  async function loadPoints(q, signal) {
    let after = null;
    let total = null;
    let fetched = 0;
    while (fetched < q.limit) {
      const size = Math.min(PAGE_SIZE, q.limit - fetched);
      const p = apiParams(q);
      p.set('size', String(size));
      p.set('fields', FIELDS.join(','));
      if (after) p.set('after', after);
      const data = await fetchJSON(`${API}/occurrence?${p}`, signal);
      const results = Array.isArray(data && data.results) ? data.results : [];
      fetched += results.length;
      if (total === null) total = Number.isFinite(Number(data && data.total)) ? Number(data.total) : results.length;
      const page = [];
      for (const r of results) {
        const lat = Number(r.decimalLatitude);
        const lon = Number(r.decimalLongitude);
        if (!validCoord(lat, lon)) { state.skipped += 1; continue; }
        page.push({ ...r, decimalLatitude: lat, decimalLongitude: lon });
      }
      state.records.push(...page);
      state.plotted = state.records.length;
      state.total = total;
      addPoints(page);
      if (results.length < size || !results.length) break;
      const lastId = results[results.length - 1].id;
      if (typeof lastId !== 'string' || !lastId) break;
      after = lastId;
      setStatus(`Loading ${speciesLabel(q.species)} records… ${nf.format(state.plotted)} of ${nf.format(total)}`);
    }
    let msg;
    if (!state.total) {
      msg = 'No records match these filters.';
    } else {
      msg = `Showing ${nf.format(state.plotted)} of ${nf.format(state.total)} ${speciesLabel(q.species)} records`;
      msg += state.plotted + state.skipped < state.total ? ', an arbitrary subset.' : '.';
      if (state.skipped) msg += ` ${nf.format(state.skipped)} without valid coordinates were skipped.`;
    }
    setStatus(msg);
  }

  async function loadDensity(q, signal) {
    const data = await fetchJSON(`${API}/occurrence/grid/${GRID_PRECISION}?${apiParams(q)}`, signal);
    const features = Array.isArray(data && data.features) ? data.features : [];
    state.grid = { type: 'FeatureCollection', features };
    state.cells = features.length;
    state.total = features.reduce((sum, f) => sum + cellCount(f.properties), 0);
    renderGrid(state.grid);
    setStatus(state.cells
      ? `Density of ${nf.format(state.total)} ${speciesLabel(q.species)} records in ${nf.format(state.cells)} cells of about 150 km.`
      : 'No records match these filters.');
  }

  let controller = null;
  async function update({ fit } = {}) {
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    const q = queryFromForm();
    writeHash(q);
    ui.limitRow.hidden = q.view !== 'points';
    clearError();
    Object.assign(state, {
      view: q.view, species: q.species, loading: true, plotted: 0, total: 0, skipped: 0, cells: 0, records: [], grid: null,
    });
    dataLayer.clearLayers();
    renderLegend();
    updateDownload();
    ui.load.disabled = true;
    setStatus(`Loading ${speciesLabel(q.species)} records…`);

    try {
      if (q.view === 'points') await loadPoints(q, signal);
      else await loadDensity(q, signal);
      renderLegend();
      updateDownload();
      if (fit && dataLayer.getLayers().length) {
        const b = dataLayer.getBounds();
        if (b.isValid()) map.fitBounds(b, { padding: [24, 24], maxZoom: 5 });
      }
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      const detail = err && err.message ? err.message : String(err);
      showError(`Could not load records from OBIS: ${detail}. Try again in a moment.`);
      setStatus(state.plotted ? `Showing ${nf.format(state.plotted)} records loaded before the error.` : 'No records loaded.');
      renderLegend();
      updateDownload();
    } finally {
      if (controller && controller.signal === signal) {
        state.loading = false;
        ui.load.disabled = false;
      }
    }
  }

  // ---------- Wiring ----------
  for (const s of SPECIES) {
    const opt = el('option', null, `${s.common} (${s.name})`);
    opt.value = s.name;
    ui.species.append(opt);
  }
  ui.from.max = String(MAX_YEAR);
  ui.to.max = String(MAX_YEAR);

  let lastSpecies = null;
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = queryFromForm();
    const fit = q.species !== lastSpecies;
    lastSpecies = q.species;
    update({ fit });
  });
  ui.species.addEventListener('change', () => ui.form.requestSubmit());
  ui.form.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener('change', () => ui.form.requestSubmit()));

  function setCollapsed(collapsed) {
    ui.panel.classList.toggle('collapsed', collapsed);
    ui.toggle.textContent = collapsed ? 'Show filters' : 'Hide filters';
    ui.toggle.setAttribute('aria-expanded', String(!collapsed));
  }
  ui.toggle.addEventListener('click', () => setCollapsed(!ui.panel.classList.contains('collapsed')));
  setCollapsed(narrow);

  darkQuery.addEventListener('change', () => { setTiles(); redraw(); });

  window.addEventListener('hashchange', () => {
    const q = queryFromHash();
    applyQueryToForm(q);
    const fit = q.species !== lastSpecies;
    lastSpecies = q.species;
    update({ fit });
  });

  const version = document.querySelector('meta[name="app-version"]').content;
  const built = document.querySelector('meta[name="build-date"]').content;
  ui.version.textContent = version.startsWith('__') ? 'dev build' : version;
  if (!built.startsWith('__')) ui.version.title = `Built ${built}`;

  window.sharkMap = { map, state };

  const initial = queryFromHash();
  applyQueryToForm(initial);
  lastSpecies = initial.species;
  update({ fit: false });
})();
