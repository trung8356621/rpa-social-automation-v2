"""Read-only session/cookie METADATA audit. Never prints cookie names or values."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import time
from urllib.parse import urlparse

ROOT = r"D:\work-app\new\rpa-social-automation-v2\.local"
OUT = []


def audit_cookies(label: str, cookies_path: str, partition_name: str) -> None:
    info = {
        "label": label,
        "partition": partition_name,
        "cookiesDbPathExists": os.path.exists(cookies_path),
        "cookiesDbRel": os.path.relpath(cookies_path, ROOT) if os.path.exists(cookies_path) else None,
    }
    if not os.path.exists(cookies_path):
        OUT.append(info)
        return
    st = os.stat(cookies_path)
    info["cookiesDbBytes"] = st.st_size
    info["cookiesDbMtime"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(st.st_mtime))
    tmp = tempfile.mktemp(suffix=".db")
    shutil.copy2(cookies_path, tmp)
    try:
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        cur = con.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [r[0] for r in cur.fetchall()]
        info["tables"] = tables
        if "cookies" in tables:
            cur.execute("SELECT COUNT(*) FROM cookies")
            info["cookieCount"] = cur.fetchone()[0]
            cur.execute(
                """
                SELECT COUNT(*) FROM cookies
                WHERE host_key LIKE '%facebook%'
                   OR host_key LIKE '%fb.com%'
                   OR host_key LIKE '%meta.com%'
                """
            )
            info["facebookRelatedCookieCount"] = cur.fetchone()[0]
            cur.execute(
                """
                SELECT COUNT(DISTINCT host_key) FROM cookies
                WHERE host_key LIKE '%facebook%'
                   OR host_key LIKE '%fb.com%'
                   OR host_key LIKE '%meta.com%'
                """
            )
            info["facebookRelatedHostCount"] = cur.fetchone()[0]
            cur.execute(
                """
                SELECT DISTINCT host_key FROM cookies
                WHERE host_key LIKE '%facebook%'
                   OR host_key LIKE '%fb.com%'
                   OR host_key LIKE '%meta.com%'
                ORDER BY 1 LIMIT 30
                """
            )
            info["facebookRelatedHosts"] = [r[0] for r in cur.fetchall()]
        con.close()
    except Exception as e:
        info["error"] = str(e)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    OUT.append(info)


def find_cookies_db(partition_dir: str) -> str | None:
    candidates = [
        os.path.join(partition_dir, "Network", "Cookies"),
        os.path.join(partition_dir, "Cookies"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


creator_part = os.path.join(ROOT, "creator", "chromium", "Partitions", "creator-default")
db = find_cookies_db(creator_part)
if db:
    audit_cookies("creator/persist:creator-default", db, "persist:creator-default")
else:
    OUT.append({"label": "creator/persist:creator-default", "cookiesDbPathExists": False})

default_part = os.path.join(ROOT, "creator", "chromium", "Partitions", "default")
db2 = find_cookies_db(default_part)
if db2:
    audit_cookies("creator/Partitions/default", db2, "(non-persist default dir name)")

checks = sorted(d for d in os.listdir(ROOT) if d.startswith("post-detail-check-"))
for d in checks[-2:]:
    for part_name in ("creator-default", "default"):
        pdir = os.path.join(ROOT, d, "chromium", "Partitions", part_name)
        cdb = find_cookies_db(pdir)
        if cdb:
            audit_cookies(f"{d}/{part_name}", cdb, f"persist:{part_name}" if part_name != "default" else "default")

# creator.sqlite session metadata
sqlite_path = os.path.join(ROOT, "creator", "creator.sqlite")
meta = {"label": "creator.sqlite", "exists": os.path.exists(sqlite_path)}
if os.path.exists(sqlite_path):
    tmp = tempfile.mktemp(suffix=".sqlite")
    shutil.copy2(sqlite_path, tmp)
    con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    meta["tables"] = [r[0] for r in cur.fetchall()]
    settings = {}
    queries = [
        "SELECT key, value FROM settings WHERE key IN ('browserSessions','activeBrowserSessionId','lastUrl')",
        "SELECT name, value FROM settings WHERE name IN ('browserSessions','activeBrowserSessionId','lastUrl')",
    ]
    for q in queries:
        try:
            cur.execute(q)
            rows = cur.fetchall()
            if not rows:
                continue
            for k, v in rows:
                if k == "browserSessions":
                    sessions = json.loads(v)
                    settings[k] = [
                        {
                            "id": s.get("id"),
                            "name": s.get("name"),
                            "partition": s.get("partition"),
                            "isDefault": s.get("isDefault"),
                            "updatedAt": s.get("updatedAt"),
                            "domainCount": len(s.get("domains") or []),
                            "lastUrlHost": (urlparse(s["lastUrl"]).hostname if s.get("lastUrl") else None),
                        }
                        for s in sessions
                    ]
                elif k == "lastUrl":
                    settings[k] = {
                        "hostname": urlparse(v).hostname if v else None,
                        "hasUrl": bool(v),
                    }
                else:
                    settings[k] = v
            break
        except Exception as e:
            meta.setdefault("queryErrors", []).append(str(e))
    # fallback: dump setting-like tables keys only
    if not settings:
        for table in meta.get("tables") or []:
            try:
                cur.execute(f"PRAGMA table_info({table})")
                cols = [r[1] for r in cur.fetchall()]
                if "key" in cols and "value" in cols:
                    cur.execute(f"SELECT key FROM {table} LIMIT 50")
                    meta.setdefault("settingKeysSample", {})[table] = [r[0] for r in cur.fetchall()]
            except Exception:
                pass
    meta["settings"] = settings
    con.close()
    os.remove(tmp)
OUT.append(meta)

report = {
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "note": "Metadata only. No cookie names/values exported.",
    "expectedNormalUserData": os.path.join(ROOT, "creator"),
    "expectedDefaultPartition": "persist:creator-default",
    "smokeTestUserDataPattern": ".local/post-detail-check-<pid>",
    "results": OUT,
}
out_path = os.path.join(ROOT, "..", "scratch", "post-detail-geometry", "session-audit.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(report, f, indent=2)
print(json.dumps(report, indent=2))
