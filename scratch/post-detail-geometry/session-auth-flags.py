"""Presence flags for known Facebook cookie NAMES only — no values."""
import json
import os
import shutil
import sqlite3
import tempfile

SRC = r"D:\work-app\new\rpa-social-automation-v2\.local\creator\chromium\Partitions\creator-default\Network\Cookies"
KNOWN = ["c_user", "xs", "datr", "sb", "fr", "wd", "presence", "spin"]

tmp = tempfile.mktemp(suffix=".db")
shutil.copy2(SRC, tmp)
con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
cur = con.cursor()
cur.execute("PRAGMA table_info(cookies)")
cols = [r[1] for r in cur.fetchall()]
cur.execute("SELECT name, host_key, is_httponly, is_secure FROM cookies")
rows = cur.fetchall()
present = {n: False for n in KNOWN}
hosts = set()
for name, host, httponly, secure in rows:
    hosts.add(host)
    if name in present:
        present[name] = {
            "present": True,
            "host": host,
            "httpOnly": bool(httponly),
            "secure": bool(secure),
        }
con.close()
os.remove(tmp)

# logged-in heuristic: c_user + xs typically required
logged_in_heuristic = bool(
    isinstance(present.get("c_user"), dict)
    and present["c_user"].get("present")
    and isinstance(present.get("xs"), dict)
    and present["xs"].get("present")
)

report = {
    "cookieTableColumns": cols,
    "totalCookiesInDb": len(rows),
    "hosts": sorted(hosts),
    "knownNamePresence": present,
    "loggedInHeuristic_c_user_and_xs": logged_in_heuristic,
    "note": "Flags only; cookie values never read/printed",
}
print(json.dumps(report, indent=2))
with open(
    r"D:\work-app\new\rpa-social-automation-v2\scratch\post-detail-geometry\session-auth-flags.json",
    "w",
    encoding="utf-8",
) as f:
    json.dump(report, f, indent=2)
