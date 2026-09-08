"""현재 3개월 목표 연구의 공개 원문을 보존하고 해시와 관측일을 기록한다."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
import urllib.request


# 수익률을 보기 전에 업종 대표 범위로 정한 종목군이다.
ETFS = {
    "069500": ("KODEX 200", "market"),
    "229200": ("KODEX 코스닥150", "market"),
    "091160": ("KODEX 반도체", "semiconductor"),
    "091170": ("KODEX 은행", "bank"),
    "091180": ("KODEX 자동차", "auto"),
    "117460": ("KODEX 에너지화학", "energy"),
    "117680": ("KODEX 철강", "steel"),
    "140700": ("KODEX 보험", "insurance"),
    "140710": ("KODEX 운송", "transport"),
    "102960": ("KODEX 기계장비", "machinery"),
    "139220": ("TIGER 200 건설", "construction"),
    "139280": ("TIGER 경기방어", "defensive"),
    "244580": ("KODEX 바이오", "bio"),
    "305720": ("KODEX 2차전지산업", "battery"),
}


def sources(asof):
    end = asof.replace("-", "") + "2359"
    yield "etf-catalog.json", "https://finance.naver.com/api/sise/etfItemList.nhn", "euc-kr"
    for code in ETFS:
        yield f"etf-{code}.json", f"https://api.stock.naver.com/chart/domestic/item/{code}/day?startDateTime=201001010000&endDateTime={end}", "utf-8"
    for code in ("KOSPI", "KOSDAQ"):
        yield f"index-{code}.json", f"https://api.stock.naver.com/chart/domestic/index/{code}/day?startDateTime=201001010000&endDateTime={end}", "utf-8"
    for code in ("DCOILBRENTEU", "DCOILWTICO", "DEXKOUS", "DFF", "DGS10"):
        yield f"fred-{code}-2015.csv", f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={code}&cosd=2015-01-01&coed={asof}", "utf-8"
    for code in ("XTEXVA01KRM667N", "VALEXPKRM052N"):
        yield f"fred-{code}.csv", f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={code}&cosd=2014-01-01&coed={asof}", "utf-8"
    yield "vix.csv", "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv", "utf-8"
    yield "bok.html", "https://www.bok.or.kr/portal/singl/baseRate/list.do?menuNo=200643", "utf-8"
    yield "bok-decision.html", "https://www.bok.or.kr/portal/bbs/P0000559/view.do?menuNo=200690&nttId=11064191", "utf-8"
    yield "cpi-release.html", "https://www.korea.kr/news/policyNewsView.do?newsId=156777515", "utf-8"
    yield "exports-release.html", "https://www.korea.kr/briefing/pressReleaseView.do?newsId=156776348", "utf-8"
    yield "eia-outlook.html", "https://www.eia.gov/outlooks/STEO/", "utf-8"


def fetch(root, asof):
    root.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, url, encoding in sources(asof):
        path = root / name
        if not path.exists():
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            try:
                with urllib.request.urlopen(request, timeout=40) as response:
                    raw = response.read()
                if not raw:
                    raise ValueError("빈 원문")
                if name.endswith(".json"):
                    json.loads(raw.decode(encoding))
                with path.open("xb") as stream:
                    stream.write(raw)
            except Exception as error:
                entry = {"file": name, "url": url, "status": "failed", "error": str(error)}
                manifest.append(entry)
                print(json.dumps(entry, ensure_ascii=False), flush=True)
                continue
            time.sleep(.25)
        raw = path.read_bytes()
        entry = {"file": name, "url": url, "encoding": encoding, "status": "saved",
                 "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
        if name.startswith(("etf-", "index-")) and name != "etf-catalog.json":
            rows = json.loads(raw.decode(encoding))
            if not isinstance(rows, list) or not rows:
                raise ValueError(f"가격 응답이 유효하지 않습니다: {name}")
            entry.update(rows=len(rows), first=rows[0]["localDate"], last=rows[-1]["localDate"])
        manifest.append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)
    (root / "manifest.json").write_text(json.dumps({"asof": asof, "recordedAt": datetime.now(timezone.utc).isoformat(),
        "universe": {k: {"name": v[0], "sector": v[1]} for k, v in ETFS.items()}, "sources": manifest}, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--asof", default="2026-09-08")
    args = parser.parse_args()
    fetch(args.root, args.asof)
