"""One-off probe: public shark tracking studies on Movebank, and whether a browser can load them."""
import csv, io, json, urllib.parse, urllib.request

BASE = "https://www.movebank.org/movebank/service"
SHARK_GENERA = ("Carcharodon", "Carcharhinus", "Prionace", "Galeocerdo", "Rhincodon", "Isurus", "Lamna",
                "Cetorhinus", "Sphyrna", "Negaprion", "Somniosus", "Ginglymostoma", "Alopias", "Notorynchus",
                "Triaenodon", "Squalus", "Hexanchus", "Mustelus", "Galeorhinus", "Carcharias")


def get(url, origin=False):
    headers = {"User-Agent": "shark-map-probe"}
    if origin:
        headers["Origin"] = "https://wadelab.github.io"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.status, dict(r.headers), r.read()


status, headers, body = get(f"{BASE}/direct-read?entity_type=study")
print("study list:", status, headers.get("Content-Type"), len(body), "bytes")
rows = list(csv.DictReader(io.StringIO(body.decode("utf-8", "ignore"))))
print("studies visible anonymously:", len(rows))
print("columns:", ", ".join(list(rows[0].keys())[:40]) if rows else "-")
sharks = [r for r in rows if any(g.lower() in (r.get("taxon_ids", "") + " " + r.get("name", "")).lower()
                                 for g in SHARK_GENERA) or "shark" in r.get("name", "").lower()]
print("shark-like studies:", len(sharks))
keys = ["id", "name", "taxon_ids", "license_type", "i_have_download_access", "i_can_see_data",
        "there_are_data_which_i_cannot_see", "timestamp_last_deployed_location", "number_of_deployed_locations",
        "sensor_type_ids"]
sharks.sort(key=lambda r: r.get("timestamp_last_deployed_location") or "", reverse=True)
for r in sharks[:40]:
    print(" | ".join(f"{k}={str(r.get(k, ''))[:60]}" for k in keys))

print("\n## public/json checks (browser-style request with Origin header)")
for r in [r for r in sharks if r.get("i_can_see_data") == "true"][:8]:
    sid = r["id"]
    url = f"{BASE}/public/json?study_id={sid}&max_events_per_individual=3"
    try:
        status, headers, body = get(url, origin=True)
        text = body.decode("utf-8", "ignore")
        try:
            d = json.loads(text)
            inds = d.get("individuals", [])
            pts = sum(len(i.get("locations", [])) for i in inds)
            last = max((loc.get("timestamp", 0) for i in inds for loc in i.get("locations", [])), default=None)
            print(f"  {sid}: {status} ACAO={headers.get('Access-Control-Allow-Origin')} individuals={len(inds)} "
                  f"points={pts} keys={list(d.keys())[:6]} last_ts={last}")
        except json.JSONDecodeError:
            print(f"  {sid}: {status} ACAO={headers.get('Access-Control-Allow-Origin')} non-JSON: {text[:150]!r}")
    except Exception as e:  # noqa: BLE001
        print(f"  {sid}: error {str(e)[:150]}")
