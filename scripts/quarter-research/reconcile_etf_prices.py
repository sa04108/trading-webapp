"""실제 일별 시세표로 차트 결손을 보강하고 연도별 원가격을 교차 검증한다."""

import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
import time
import urllib.request

from fetch_sources import ETFS


def parse_table(raw):
    """스크립트를 실행하지 않고 날짜가 있는 시세 행의 일곱 셀만 읽는다."""
    rows = {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", raw.decode("euc-kr", errors="replace"), flags=re.S):
        cells = [re.sub(r"\s+", "", html.unescape(re.sub(r"<[^>]*>", "", value)))
                 for value in re.findall(r"<td[^>]*>(.*?)</td>", row, flags=re.S)]
        if len(cells) != 7 or not re.fullmatch(r"\d{4}\.\d{2}\.\d{2}", cells[0]):
            continue
        date = cells[0].replace(".", "")
        close, open_, high, low, volume = [float(cells[i].replace(",", "")) for i in (1, 3, 4, 5, 6)]
        if not 0 < low <= min(open_, close) <= max(open_, close) <= high or volume < 0:
            raise ValueError(f"일별 시세 원문의 OHLC가 유효하지 않습니다: {date}")
        rows[date] = {"open": open_, "high": high, "low": low, "close": close, "volume": volume}
    if not rows:
        raise ValueError("가격 행이 없는 시세표입니다")
    return rows


def reconcile(root):
    sources = root / "sources-20260908"
    raw_root = root / "etf-raw-20260908"
    pages = root / "etf-tables-20260908"
    pages.mkdir(parents=True, exist_ok=True)
    audit = {}
    manifest = []
    repairs = {}
    for code in ETFS:
        nav = json.loads((sources / f"etf-{code}.json").read_text())
        dates = [r["localDate"] for r in nav]
        data = json.loads((raw_root / f"{code}.json").read_text())["chart"]["result"][0]
        quote = data["indicators"]["quote"][0]
        yahoo = {datetime.fromtimestamp(ts, timezone.utc).strftime("%Y%m%d"): {k: v[i] for k, v in quote.items()}
                 for i, ts in enumerate(data["timestamp"])}
        missing = [d for d in dates if d >= "20150101" and (d not in yahoo or any(yahoo[d][k] is None for k in ("open", "high", "low", "close", "volume")))]
        checks = [next((d for d in dates if d.startswith(str(year))), None) for year in range(2015, 2027)]
        targets = sorted(set(missing + [d for d in checks if d] + dates[-1:]))
        wanted = sorted({(len(dates) - 1 - dates.index(d)) // 10 + 1 for d in targets})
        table_rows = {}
        for page in wanted:
            name = f"{code}-{page}.html"
            path = pages / name
            url = f"https://finance.naver.com/item/sise_day.naver?code={code}&page={page}"
            if not path.exists():
                request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(request, timeout=25) as response:
                    raw = response.read()
                parse_table(raw)
                with path.open("xb") as stream:
                    stream.write(raw)
                time.sleep(.25)
            raw = path.read_bytes()
            table_rows.update(parse_table(raw))
            manifest.append({"file": name, "url": url, "sha256": hashlib.sha256(raw).hexdigest()})
        absent = [d for d in targets if d not in table_rows]
        if absent:
            raise ValueError(f"페이지 날짜가 예상과 다릅니다: {code} {absent}")
        differences = []
        for date, row in table_rows.items():
            original = yahoo.get(date)
            if original and original["close"] is not None:
                if any(abs(row[k] - original[k]) > .1 for k in ("open", "high", "low", "close")):
                    differences.append({"date": date, "table": row, "chart": original})
        # 원가격이 확인된 시세표 행은 그대로 쓰며 원본 응답을 덮어쓰지 않는다.
        repairs[code] = table_rows
        audit[code] = {"missingDates": missing, "tableRows": len(table_rows), "priceDifferences": differences,
                       "yahooVolumeDiffers": sum(1 for d, r in table_rows.items() if d in yahoo and yahoo[d]["volume"] is not None and r["volume"] != yahoo[d]["volume"])}
        print(json.dumps({"symbol": code, "missing": len(missing), "tableRows": len(table_rows), "priceDifferences": len(differences)}, ensure_ascii=False), flush=True)
    (root / "etf-price-repairs.json").write_text(json.dumps({"rows": repairs, "audit": audit, "sources": manifest}, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    reconcile(parser.parse_args().root)
