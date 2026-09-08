"""검증된 ETF 체결가와 과거에 관측 가능한 거시값으로 연구 입력을 만든다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re

import numpy as np
import pandas as pd

from fetch_sources import ETFS


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def lagged_values(observations, dates, lag_days=1):
    """자료 관측일에 보수적 공개 지연을 더한 뒤 해당 날짜까지만 전진 채운다."""
    rows = sorted((str(d), float(v)) for d, v in observations if v is not None and np.isfinite(float(v)))
    available = np.array([np.datetime64(d) + np.timedelta64(lag_days, "D") for d, _ in rows])
    index = np.searchsorted(available, np.array(dates, dtype="datetime64[D]"), side="right") - 1
    if np.any(index < 0):
        raise ValueError("거시 관측의 시작 이력이 부족합니다")
    return np.array([rows[i][1] for i in index]), [rows[i][0] for i in index]


def prepare(root):
    source = root / "sources-20260908"
    index_rows = json.loads((source / "index-KOSPI.json").read_text())
    dates = [pd.Timestamp(r["localDate"]).strftime("%Y-%m-%d") for r in index_rows if r["localDate"] >= "20150201"]
    day_index = {d: i for i, d in enumerate(dates)}
    ts = [int(pd.Timestamp(d, tz="UTC").timestamp() * 1000) for d in dates]
    repairs = json.loads((root / "etf-price-repairs.json").read_text())
    candles, nontrading, audit, distributions = [], {}, {}, {}
    close_matrix = {}
    volume_matrix = {}
    for symbol in ETFS:
        raw = json.loads((root / "etf-raw-20260908" / f"{symbol}.json").read_text())["chart"]["result"][0]
        if raw.get("events", {}).get("splits"):
            raise ValueError(f"분할 원가격 인증이 필요한 ETF입니다: {symbol}")
        q = raw["indicators"]["quote"][0]
        quotes = {datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"): {k: v[i] for k, v in q.items()}
                  for i, t in enumerate(raw["timestamp"])}
        for d, row in repairs["rows"][symbol].items():
            quotes[pd.Timestamp(d).strftime("%Y-%m-%d")] = row
        nav = json.loads((source / f"etf-{symbol}.json").read_text())
        expected = {pd.Timestamp(r["localDate"]).strftime("%Y-%m-%d") for r in nav}
        closes = np.full(len(dates), np.nan)
        volumes = np.zeros(len(dates))
        for d in dates:
            if d not in expected:
                continue
            row = quotes.get(d)
            if row is None or any(row[k] is None for k in ("open", "high", "low", "close", "volume")):
                raise ValueError(f"거래일 체결가 누락: {symbol} {d}")
            o, h, l, c, v = (float(row[k]) for k in ("open", "high", "low", "close", "volume"))
            if not 0 < l <= min(o, c) <= max(o, c) <= h or v < 0:
                raise ValueError(f"체결가 OHLC 계약 위반: {symbol} {d}")
            i = day_index[d]
            closes[i], volumes[i] = c, v
            if v == 0:
                nontrading.setdefault(ts[i], []).append(symbol)
                continue
            candles.append({"symbol": symbol, "tsMs": ts[i], "market": "KR", "venue": "KOSPI", "timeframe": "1d",
                            "open": o, "high": h, "low": l, "close": c, "volume": v})
        close_matrix[symbol], volume_matrix[symbol] = closes, volumes
        audit[symbol] = {"first": min(expected), "last": max(expected), "bars": int(np.isfinite(closes).sum()),
                         "rawSha256": sha(root / "etf-raw-20260908" / f"{symbol}.json"), **repairs["audit"][symbol]}
        distributions[symbol] = list(raw.get("events", {}).get("dividends", {}).values())
    closes = pd.DataFrame(close_matrix, index=dates)
    volumes = pd.DataFrame(volume_matrix, index=dates)
    liquidity = (closes * volumes).rolling(20, min_periods=20).mean()
    age = closes.notna().cumsum()
    # 해당 신호일까지 알려진 20일 거래대금과 126거래일 이력만 자격에 사용한다.
    eligible = (liquidity >= 500_000_000) & (age >= 126) & (volumes > 0)
    members = [[s for s in ETFS if bool(eligible.loc[d, s])] for d in dates]

    kospi_map = {pd.Timestamp(r["localDate"]).strftime("%Y-%m-%d"): r["closePrice"] for r in index_rows}
    kosdaq_map = {pd.Timestamp(r["localDate"]).strftime("%Y-%m-%d"): r["closePrice"]
                  for r in json.loads((source / "index-KOSDAQ.json").read_text())}
    all_dates = [pd.Timestamp(r["localDate"]).strftime("%Y-%m-%d") for r in index_rows]
    kp = pd.Series([kospi_map[d] for d in all_dates], index=all_dates)
    kq = pd.Series([kosdaq_map[d] for d in all_dates], index=all_dates)
    macro = pd.DataFrame(index=dates)
    macro["kospi"], macro["kosdaq"] = kp, kq
    for n in (20, 60, 120):
        macro[f"kospiSma{n}"] = kp.rolling(n).mean()
        macro[f"kospiRet{n}"] = kp.pct_change(n)
    macro["kosdaqRet60"] = kq.pct_change(60)
    macro["kospiVol20"] = kp.pct_change().rolling(20).std() * np.sqrt(252)
    macro["kospiDrawdown60"] = kp / kp.rolling(60).max() - 1
    macro["breadth60"] = ((closes > closes.rolling(60).mean()) & (age >= 126)).sum(axis=1) / (age >= 126).sum(axis=1).replace(0, np.nan)
    # FRED의 일별 관측은 발표 시각 원장이 없어 7일 지연을 명시적으로 적용한다.
    for name, code in (("oil", "DCOILBRENTEU"), ("wti", "DCOILWTICO"), ("fx", "DEXKOUS"), ("fed", "DFF"), ("us10y", "DGS10")):
        frame = pd.read_csv(source / f"fred-{code}-2015.csv").dropna()
        values, observed = lagged_values(zip(frame.observation_date, frame[code]), dates, lag_days=7)
        macro[name], macro[f"{name}Date"] = values, observed
        macro[f"{name}Ret20"] = pd.Series(values, index=dates).pct_change(20)
    vix = pd.read_csv(source / "vix.csv")
    values, observed = lagged_values(zip(pd.to_datetime(vix.DATE).dt.strftime("%Y-%m-%d"), vix.CLOSE), dates)
    macro["vix"], macro["vixDate"] = values, observed
    rate_rows = re.findall(r'<td class="fb">(\d{4})</td>\s*<td[^>]*>\s*(\d{2})월\s*(\d{2})일\s*</td>\s*<td[^>]*>\s*([\d.]+)', (source / "bok.html").read_text())
    if not rate_rows:
        raise ValueError("금리 이력 표 파싱 실패")
    values, observed = lagged_values([(f"{y}-{m}-{d}", v) for y, m, d, v in rate_rows], dates)
    macro["rate"], macro["rateDate"] = values, observed
    macro["rateChange60"] = pd.Series(values, index=dates).diff(60)
    numeric = macro.select_dtypes(include="number")
    if not np.isfinite(numeric.loc["2016-01-01":].to_numpy()).all():
        raise ValueError("평가 구간의 거시 지표가 완전하지 않습니다")
    points = []
    for i, d in enumerate(dates):
        point = {"date": d, "tsMs": ts[i], **macro.loc[d].to_dict()}
        for k, v in list(point.items()):
            if isinstance(v, (float, np.floating)) and not np.isfinite(v):
                point[k] = None
        points.append(point)
    result = {"asof": dates[-1], "candles": candles, "days": dates, "macro": points,
              "members": members, "nontrading": [[t, s] for t, s in nontrading.items()],
              "audit": audit, "dividendsNotCredited": distributions,
              "metadata": {"initialCash": 100_000_000, "etfCount": len(ETFS), "prices": "raw OHLC; Yahoo with verified Npay table replacements",
                           "dividends": "excluded from signal and account; price-only conservative diagnostic",
                           "volume": "Yahoo historical volume differs from Npay; table values used where verified",
                           "macroAvailability": "FRED observation + 7 calendar days; VIX and BOK + 1 day",
                           "repairsSha256": sha(root / "etf-price-repairs.json"),
                           "sourceHashes": {p.name: sha(p) for p in source.iterdir() if p.is_file()},
                           "survivorship": "current sector representatives; no delisted ETF coverage"}}
    destination = root / "etf-input.json.gz"
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    (root / "current-state.json").write_text(json.dumps({"asof": dates[-1], "macro": points[-1], "eligible": members[-1],
        "etfs": [{"symbol": s, "name": ETFS[s][0], "close": closes[s].iloc[-1], "ret20Pct": (closes[s].iloc[-1] / closes[s].iloc[-21] - 1) * 100,
                  "ret60Pct": (closes[s].iloc[-1] / closes[s].iloc[-61] - 1) * 100, "adv20": liquidity[s].iloc[-1]} for s in ETFS],
        "inputSha256": sha(destination)}, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
    print(json.dumps({"output": str(destination), "candles": len(candles), "days": len(dates), "latest": points[-1]}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    prepare(parser.parse_args().root)
