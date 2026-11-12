import json
import os
import shutil
import sqlite3
import tempfile
from urllib.parse import urlparse

p = r"D:\work-app\new\rpa-social-automation-v2\.local\creator\creator.sqlite"
t = tempfile.mktemp(suffix=".sqlite")
shutil.copy2(p, t)
c = sqlite3.connect(f"file:{t}?mode=ro", uri=True)
cur = c.cursor()
cur.execute("SELECT key FROM settings ORDER BY key")
keys = [r[0] for r in cur.fetchall()]
wanted = ["activeBrowserSessionId", "browserSessions", "lastUrl"]
vals = {}
for k in wanted:
    cur.execute("SELECT value FROM settings WHERE key=?", (k,))
    row = cur.fetchone()
    if not row:
        vals[k] = None
        continue
    v = row[0]
    if k == "browserSessions":
        sessions = json.loads(v)
        vals[k] = [
            {
                "id": s.get("id"),
                "partition": s.get("partition"),
                "isDefault": s.get("isDefault"),
                "domainCount": len(s.get("domains") or []),
                "lastUrlHost": urlparse(s["lastUrl"]).hostname if s.get("lastUrl") else None,
                "updatedAt": s.get("updatedAt"),
            }
            for s in sessions
        ]
    elif k == "lastUrl":
        vals[k] = {"hostname": urlparse(v).hostname if v else None, "hasUrl": bool(v)}
    else:
        vals[k] = v
c.close()
os.remove(t)
print(json.dumps({"settingKeys": keys, "sessionSettings": vals}, indent=2))
