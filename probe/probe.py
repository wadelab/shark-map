"""One-off probe: what tag (telemetry) data does OBIS hold for the map's species and periods?"""
import collections, json, sys, time, urllib.parse, urllib.request
from datetime import date, timedelta

API = "https://api.obis.org/v3"
TODAY = date.today()
YEAR_AGO = TODAY.replace(year=TODAY.year - 1)
FIVE_AGO = TODAY.replace(year=TODAY.year - 5)
NS = "POLYGON((-70 40,-54 40,-54 50,-70 50,-70 40))"  # Gulf of Maine to Newfoundland


def get(path, **params):
    url = f"{API}/{path}?{urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})}"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            print(f"  retry {attempt}: {e}", file=sys.stderr)
            time.sleep(3)
    raise SystemExit(f"failed: {url}")


def fetch_all(cap=20000, **params):
    out, after = [], None
    while len(out) < cap:
        d = get("occurrence", size=5000, after=after,
                fields="id,basisOfRecord,dataset_id,eventDate,date_year,samplingProtocol,occurrenceRemarks", **params)
        res = d.get("results", [])
        out += res
        if len(res) < 5000:
            break
        after = res[-1]["id"]
    return d.get("total"), out


titles = {}
def title(ds):
    if ds not in titles:
        try:
            titles[ds] = get(f"dataset/{ds}").get("results", [{}])[0].get("title", "?")
        except SystemExit:
            titles[ds] = "?"
    return titles[ds]


def summarise(label, **params):
    total, recs = fetch_all(**params)
    basis = collections.Counter(r.get("basisOfRecord") for r in recs)
    print(f"\n## {label}: total={total}, fetched={len(recs)}")
    print("  basisOfRecord:", dict(basis.most_common()))
    machine = [r for r in recs if str(r.get("basisOfRecord", "")).lower() == "machineobservation"]
    if machine:
        years = collections.Counter(r.get("date_year") for r in machine)
        print("  MachineObservation by year (latest 8):", dict(sorted(years.items(), key=lambda kv: (kv[0] or 0))[-8:]))
        print("  latest MachineObservation eventDate:", max(str(r.get("eventDate")) for r in machine))
    protos = collections.Counter(r.get("samplingProtocol") for r in recs if r.get("samplingProtocol"))
    if protos:
        print("  samplingProtocol:", dict(protos.most_common(6)))
    ds = collections.Counter((r.get("dataset_id"), r.get("basisOfRecord")) for r in recs)
    print("  top datasets:")
    for (d, b), n in ds.most_common(8):
        print(f"    {n:6d}  {b:20s}  {title(d)[:90]}")
    years_all = collections.Counter(r.get("date_year") for r in recs)
    print("  all records, latest years:", dict(sorted(years_all.items(), key=lambda kv: (kv[0] or 0))[-6:]))


print("today:", TODAY)
summarise("White shark, last 12 months", scientificname="Carcharodon carcharias",
          startdate=YEAR_AGO.isoformat(), enddate=TODAY.isoformat())
summarise("White shark, last 5 years", scientificname="Carcharodon carcharias",
          startdate=FIVE_AGO.isoformat(), enddate=TODAY.isoformat())
summarise("White shark, all years", scientificname="Carcharodon carcharias")
summarise("White shark, Nova Scotia region, all years", scientificname="Carcharodon carcharias", geometry=NS)
for sp in ["Prionace glauca", "Lamna nasus", "Isurus oxyrinchus", "Galeocerdo cuvier"]:
    total, recs = fetch_all(cap=5000, scientificname=sp, startdate=FIVE_AGO.isoformat(), enddate=TODAY.isoformat())
    basis = collections.Counter(r.get("basisOfRecord") for r in recs)
    print(f"\n## {sp}, last 5 years: total={total}, sample basis={dict(basis.most_common())}")

# Other open tag sources a browser could call: does the server allow cross-site requests?
def cors(url):
    req = urllib.request.Request(url, headers={"Origin": "https://wadelab.github.io"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.headers.get("Access-Control-Allow-Origin"), r.read(400)
    except Exception as e:  # noqa: BLE001
        return "error", str(e)[:120], b""

print("\n## Other sources")
for url in [
    "https://erddap.oceantrack.org/erddap/search/index.json?page=1&itemsPerPage=20&searchFor=white%20shark",
    "https://erddap.oceantrack.org/erddap/search/index.json?page=1&itemsPerPage=20&searchFor=detections",
    "https://www.movebank.org/movebank/service/public/json?study_id=2911040&individual_local_identifiers=x&sensor_type=gps",
]:
    status, acao, body = cors(url)
    print(f"  {status} ACAO={acao} {url}")
    if status == 200 and url.endswith(("shark", "detections")):
        try:
            t = json.loads(body.decode("utf-8", "ignore") + "") if False else None
        except Exception:
            pass
for q in ["white%20shark", "detections"]:
    try:
        with urllib.request.urlopen(f"https://erddap.oceantrack.org/erddap/search/index.json?page=1&itemsPerPage=15&searchFor={q}", timeout=60) as r:
            d = json.load(r)
        cols = d["table"]["columnNames"]
        i, t = cols.index("Dataset ID"), cols.index("Title")
        print(f"  OTN ERDDAP search '{urllib.parse.unquote(q)}':")
        for row in d["table"]["rows"]:
            print(f"    {row[i]} | {row[t][:90]}")
    except Exception as e:  # noqa: BLE001
        print(f"  OTN ERDDAP search failed: {e}")
