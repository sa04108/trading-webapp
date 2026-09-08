"""현재 종목의 추가 원시 시세표로 확인된 워밍업 날짜 누락을 보강한다."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
import urllib.request

from reconcile_etf_prices import parse_table

MISSING_DAYS = ("20260818", "20260819", "20260820", "20260824")


def repair(manifest_path, destination):
    destination.mkdir(parents=True, exist_ok=True)
    raw_manifest = manifest_path.read_bytes()
    manifest = json.loads(raw_manifest)
    sources = []
    for index, symbol in enumerate(manifest["selected"]):
        code = symbol["symbol"]
        url = f'https://finance.naver.com/item/sise_day.naver?code={code}&page=2'
        path = destination / f'{code}__page2.html'
        if not path.exists():
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=25) as response:
                raw = response.read()
            with path.open("xb") as stream:
                stream.write(raw)
            time.sleep(.25)
        raw = path.read_bytes()
        table = parse_table(raw)
        if any(day not in table for day in MISSING_DAYS):
            raise ValueError(f"필요한 결손 날짜를 원시 시세표에서 확인하지 못했습니다: {code}")
        for day, values in table.items():
            if day > manifest["asof"].replace("-", ""):
                raise ValueError("기준일 이후 시세가 포함됐습니다")
            previous = manifest["tables"][code].get(day)
            if previous is not None and previous != values:
                raise ValueError(f"이미 저장한 시세표와 값이 다릅니다: {code} {day}")
            manifest["tables"][code][day] = values
        sources.append({"file": str(path), "url": url, "sha256": hashlib.sha256(raw).hexdigest()})
        if (index + 1) % 10 == 0:
            print(json.dumps({"completed": index + 1, "total": len(manifest["selected"])}), flush=True)
    manifest["repair"] = {"originalManifest": str(manifest_path), "originalSha256": hashlib.sha256(raw_manifest).hexdigest(),
                            "recordedAt": datetime.now(timezone.utc).isoformat(), "missingDays": list(MISSING_DAYS), "sources": sources}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"manifest": str(destination / "manifest.json"), "repairedDateSymbolPairs": len(MISSING_DAYS) * len(manifest["selected"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    repair(args.manifest, args.destination)
