"""수정 차트와 대조할 ETF 원가격·분배금·분할 응답을 별도로 보존한다."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import time
import urllib.request

from fetch_sources import ETFS


def fetch(root, asof):
    root.mkdir(parents=True, exist_ok=True)
    start = int(datetime(2010, 1, 1, tzinfo=timezone.utc).timestamp())
    end = int((datetime.fromisoformat(asof).replace(tzinfo=timezone.utc) + timedelta(days=1)).timestamp())
    manifest = []
    for code in ETFS:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}.KS?period1={start}&period2={end}&interval=1d&events=div%2Csplits"
        path = root / f"{code}.json"
        if not path.exists():
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    raw = response.read()
                data = json.loads(raw)["chart"]["result"][0]
                if not data["timestamp"]:
                    raise ValueError("빈 가격 응답")
                with path.open("xb") as stream:
                    stream.write(raw)
            except Exception as error:
                entry = {"file": path.name, "url": url, "status": "failed", "error": str(error)}
                manifest.append(entry)
                print(json.dumps(entry, ensure_ascii=False), flush=True)
                continue
            time.sleep(.3)
        raw = path.read_bytes()
        data = json.loads(raw)["chart"]["result"][0]
        entry = {"file": path.name, "url": url, "status": "saved", "sha256": hashlib.sha256(raw).hexdigest(),
                 "rows": len(data["timestamp"]), "first": datetime.fromtimestamp(data["timestamp"][0], timezone.utc).isoformat(),
                 "last": datetime.fromtimestamp(data["timestamp"][-1], timezone.utc).isoformat(),
                 "dividends": len(data.get("events", {}).get("dividends", {})),
                 "splits": data.get("events", {}).get("splits", {})}
        manifest.append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)
    (root / "manifest.json").write_text(json.dumps({"asof": asof, "recordedAt": datetime.now(timezone.utc).isoformat(),
        "sources": manifest}, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--asof", default="2026-09-08")
    args = parser.parse_args()
    fetch(args.root, args.asof)
