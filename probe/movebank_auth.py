"""One-off probe: which shark studies can the site's Movebank account use, and on what terms?

The repository is public, so job logs are public. This prints study metadata, access flags,
licence types and counts only. It never prints positions or licence text, and it never
accepts a licence on the account holder's behalf.
"""
import base64, csv, io, os, sys, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://www.movebank.org/movebank/service/direct-read"
USER, PASSWORD = os.environ.get("MOVEBANK_USERNAME"), os.environ.get("MOVEBANK_PASSWORD")
if not USER or not PASSWORD:
    print("MOVEBANK_USERNAME and MOVEBANK_PASSWORD repository secrets are not set yet. Nothing to do.")
    sys.exit(0)
AUTH = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
SHARK_GENERA = ("carcharodon", "carcharhinus", "prionace", "galeocerdo", "rhincodon", "isurus", "lamna",
                "cetorhinus", "sphyrna", "negaprion", "somniosus", "ginglymostoma", "alopias", "notorynchus",
                "triaenodon", "squalus", "hexanchus", "mustelus", "galeorhinus", "carcharias", "selachii")


def get(params):
    url = BASE + "?" + "&".join(f"{k}={v}" for k, v in params.items())
    req = urllib.request.Request(url, headers={"Authorization": AUTH, "User-Agent": "shark-map-probe"})
    with urllib.request.urlopen(req, timeout=120) as r:  # one request at a time, per Movebank's limit
        return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()


try:
    status, headers, body = get({"entity_type": "study"})
except urllib.error.HTTPError as e:
    print(f"Login or study list failed: HTTP {e.code}. Check the username and password secrets.")
    sys.exit(1)
studies = list(csv.DictReader(io.StringIO(body.decode("utf-8", "ignore"))))
print(f"studies listed for this account: {len(studies)}")


def is_shark(s):
    text = (s.get("taxon_ids", "") + " " + s.get("name", "")).lower()
    return any(g in text for g in SHARK_GENERA) or "shark" in text


sharks = sorted((s for s in studies if is_shark(s)),
                key=lambda s: s.get("timestamp_last_deployed_location") or "", reverse=True)
print(f"shark studies: {len(sharks)}")
usable = [s for s in sharks if s.get("i_have_download_access") == "true"]
print(f"shark studies with download access: {len(usable)}")
licences = {}
for s in usable:
    licences[s.get("license_type") or "?"] = licences.get(s.get("license_type") or "?", 0) + 1
print("licence types among those:", licences)

print("\nmost recent shark studies (all, newest first):")
for s in sharks[:40]:
    print(f"  {s.get('id')} | {s.get('name', '')[:70]} | taxa={s.get('taxon_ids', '')[:45]} | "
          f"licence={s.get('license_type')} | download={s.get('i_have_download_access')} | "
          f"see={s.get('i_can_see_data')} | last={str(s.get('timestamp_last_deployed_location'))[:10]} | "
          f"locs={s.get('number_of_deployed_locations')} | "
          f"centre=({str(s.get('main_location_lat'))[:5]}, {str(s.get('main_location_long'))[:6]})")

print("\nrecent-data check for downloadable shark studies (counts only, last 365 days):")
since = (datetime.now(timezone.utc) - timedelta(days=365)).strftime("%Y%m%d%H%M%S000")
for s in usable[:12]:
    try:
        status, headers, body = get({"entity_type": "event", "study_id": s["id"], "attributes": "timestamp",
                                     "timestamp_start": since})
        if headers.get("accept-license") == "true":
            print(f"  {s['id']}: licence terms must be accepted by the account holder before download")
            continue
        rows = body.decode("utf-8", "ignore").strip().splitlines()
        print(f"  {s['id']}: {max(len(rows) - 1, 0)} location events in the last 365 days")
    except urllib.error.HTTPError as e:
        print(f"  {s['id']}: HTTP {e.code}")
