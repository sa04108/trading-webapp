"""현재 보통주 시가총액 종목군과 최신 실제 일별 시세표를 별도 보존한다."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
import urllib.request

import numpy as np

from reconcile_etf_prices import parse_table


def fetch(root, panel):
    root.mkdir(parents=True, exist_ok=True)
    codes = np.load(panel / "codes.npy")
    common = np.load(panel / "common.npy", mmap_mode="r")[-1]
    active = np.load(panel / "active.npy", mmap_mode="r")[-1]
    known = {str(c) for c, ok, live in zip(codes, common, active) if ok and live}
    sources = []

    def get(name, url):
        path = root / name
        if not path.exists():
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=25) as response:
                raw = response.read()
            with path.open("xb") as stream:
                stream.write(raw)
            time.sleep(.25)
        raw = path.read_bytes()
        sources.append({"file": name, "url": url, "sha256": hashlib.sha256(raw).hexdigest()})
        return raw

    stocks = []
    for market in ("KOSPI", "KOSDAQ"):
        raw = get(f"{market}.json", f"https://m.stock.naver.com/api/stocks/marketValue/{market}?page=1&pageSize=100")
        for row in json.loads(raw)["stocks"]:
            if row["itemCode"] not in known or row.get("tradableStatus") != "tradable":
                continue
            stocks.append({"symbol": row["itemCode"], "name": row["stockName"], "market": market,
                           "marketCap": float(row["marketValueRaw"]), "close": float(row["closePriceRaw"]),
                           "tradedAt": row["localTradedAt"]})
    stocks.sort(key=lambda r: (-r["marketCap"], r["symbol"]))
    selected = stocks[:50]
    if len(selected) != 50:
        raise ValueError("현재 종목군이 50개보다 작습니다")
    tables = {}
    for row in selected:
        code = row["symbol"]
        raw = get(f"{code}.html", f"https://finance.naver.com/item/sise_day.naver?code={code}&page=1")
        tables[code] = parse_table(raw)
        latest = tables[code].get("20260908")
        if latest is None or latest["close"] != row["close"]:
            raise ValueError(f"현재 카탈로그와 종가 일치 확인 실패: {code}")
        print(json.dumps({"symbol": code, "name": row["name"], "close": latest["close"]}, ensure_ascii=False), flush=True)
    result = {"asof": "2026-09-08", "recordedAt": datetime.now(timezone.utc).isoformat(), "selected": selected,
              "tables": tables, "sources": sources, "commonMembershipDate": str(np.load(panel / "days.npy")[-1]),
              "note": "현재 신호 생성 전용이며 과거 백테스트의 시점별 종목군을 대체하지 않는다"}
    (root / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("panel", type=Path)
    args = parser.parse_args()
    fetch(args.root, args.panel)
