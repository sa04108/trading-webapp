"""보존한 국내 시장 원문과 공개 거시자료로 기존 엔진의 연구 입력을 만든다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
import pandas as pd


SOURCES = {
    "kospi.xml": "https://fchart.stock.naver.com/sise.nhn?symbol=KOSPI&timeframe=day&count=3000&requestType=0",
    "vix.csv": "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv",
    "bok.html": "https://www.bok.or.kr/portal/singl/baseRate/list.do?menuNo=200643",
}


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_snapshot(path):
    """시장 원문 중 종목 이력·지수·팩트만 읽고 큰 가격 표는 메모리 매핑을 쓴다."""
    tables = {}
    with gzip.open(path, "rt") as stream:
        for line in stream:
            record = json.loads(line)
            if "table" in record:
                table = record["table"]
                if table == "daily_selection_metrics":
                    break
                columns = [c[0] for c in record["columns"]]
                tables[table] = []
            elif "rows" in record:
                tables[table].extend(dict(zip(columns, row)) for row in record["rows"])
    return tables


def prior_values(observations, days, strict=True):
    """한국 장마감 후에야 확정되는 미국 관측과 당일 금리 변경을 앞당기지 않는다."""
    rows = sorted((date, float(value)) for date, value in observations if str(value) not in (".", "nan"))
    dates = np.array([row[0] for row in rows])
    values = np.array([row[1] for row in rows])
    indexes = np.searchsorted(dates, days, side="left" if strict else "right") - 1
    if np.any(indexes < 0):
        raise ValueError("벤치마크나 국면 원자료의 시작일이 부족합니다")
    return values[indexes], dates[indexes]


def prepare(source, output, universe_size, ranking="cap"):
    output.mkdir(parents=True, exist_ok=True)
    load = lambda name: np.load(source / "panel" / f"{name}.npy", mmap_mode="r")
    days, codes = load("days"), load("codes")
    end = np.searchsorted(days, "2026-08-28", side="right")
    days = days[:end]
    panel = {name: load(name)[:end] for name in (
        "open", "high", "low", "close", "volume", "cap", "value", "common", "active", "market", "nontrading",
        "reference_factor",
    )}
    tables = read_snapshot(source / "market.jsonl.gz")
    liquidity = pd.DataFrame(panel["value"]).rolling(20, min_periods=20).mean().to_numpy()
    selected = []
    members = []
    for i, day in enumerate(days):
        if i > 20 and (i == 21 or day[:7] != days[i - 1][:7]):
            eligible = panel["common"][i - 1] & (liquidity[i - 1] >= 1e9) & (panel["volume"][i - 1] > 0)
            eligible &= np.isfinite(panel["cap"][i - 1]) & (panel["cap"][i - 1] > 0)
            indexes = np.flatnonzero(eligible)
            scores = panel["cap"][i - 1] if ranking == "cap" else liquidity[i - 1]
            members = sorted(indexes, key=lambda j: (-scores[j], codes[j]))[:universe_size]
        selected.append(list(members))
    union = sorted(set(j for members in selected for j in members))
    symbols = set(str(codes[j]) for j in union)
    print(json.dumps({"days": len(days), "historical_symbols": len(union), "monthly_universe": universe_size}), flush=True)

    observations = {}
    for line in (source / "fred.jsonl").open():
        record = json.loads(line)
        observations[record["series"]] = [(r["date"], r["value"]) for r in record["observations"]]
    ndx, ndx_dates = prior_values(observations["NASDAQ100"], days)
    fx, fx_dates = prior_values(observations["DEXKOUS"], days)
    kospi_chart = ET.fromstring((output / "kospi.xml").read_bytes().decode("euc-kr"))
    kospi_rows = []
    for item in kospi_chart.iter("item"):
        date, _, _, _, close, _ = item.attrib["data"].split("|")
        kospi_rows.append((f"{date[:4]}-{date[4:6]}-{date[6:8]}", float(close)))
    stored_kospi = {r["date"]: r["close"] for r in tables["benchmark_daily_values"] if r["benchmark_id"] == "KOSPI"}
    if any(abs(stored_kospi[date] / value - 1) > 0.001 for date, value in kospi_rows if date in stored_kospi):
        raise ValueError("저장 KOSPI와 추가 API 지수 값이 일치하지 않습니다")
    if not kospi_rows or min(date for date, _ in kospi_rows) > days[0]:
        raise ValueError("KOSPI 지수 과거자료가 부족합니다")
    kospi, kospi_dates = prior_values(kospi_rows, days, strict=False)
    if not np.all(kospi_dates == days):
        raise ValueError("국내 거래일과 KOSPI 관측일이 일치하지 않습니다")
    vix_table = pd.read_csv(output / "vix.csv")
    vix_rows = list(zip(pd.to_datetime(vix_table.DATE).dt.strftime("%Y-%m-%d"), vix_table.CLOSE))
    vix, vix_dates = prior_values(vix_rows, days)
    # 표에 표시된 연도·월일·금리만 파싱하고 차트 스크립트는 실행하지 않는다.
    html = (output / "bok.html").read_text()
    rates = re.findall(r'<td class="fb">(\d{4})</td>\s*<td[^>]*>\s*(\d{2})월\s*(\d{2})일\s*</td>\s*<td[^>]*>\s*([\d.]+)', html)
    if not rates:
        raise ValueError("한국은행 기준금리 표 구조가 달라졌습니다")
    rate, rate_dates = prior_values([(f"{y}-{m}-{d}", float(v)) for y, m, d, v in rates], days)
    sma = pd.Series(kospi).rolling(60, min_periods=60).mean().to_numpy()
    regimes = {
        "high_vol": vix >= 25,
        "low_rate": rate <= 1.25,
        "kr_uptrend": kospi > sma,
        "high_vol_uptrend": (vix >= 25) & (kospi > sma),
    }
    macro = [{"date": str(day), "ndxUsd": float(ndx[i]), "ndxKrw": float(ndx[i] * fx[i]),
              "ndxDate": str(ndx_dates[i]), "fxDate": str(fx_dates[i]), "vix": float(vix[i]),
              "vixDate": str(vix_dates[i]), "rate": float(rate[i]), "rateDate": str(rate_dates[i]),
              "kospi": float(kospi[i]), "regimes": {k: bool(v[i]) for k, v in regimes.items()}}
             for i, day in enumerate(days)]

    ts = [int(pd.Timestamp(str(day), tz="UTC").timestamp() * 1000) for day in days]
    schedule = []
    for i in range(21, len(days)):
        if (i - 21) % 5:
            continue
        schedule.append({"fromTsMs": ts[i], "members": [
            {"symbol": str(codes[j]), "marketCapKrw": str(int(panel["cap"][i - 1, j])) if np.isfinite(panel["cap"][i - 1, j]) else None,
             "volume": int(panel["volume"][i - 1, j]) if np.isfinite(panel["volume"][i - 1, j]) else None,
             "tradingValueKrw": str(int(panel["value"][i - 1, j])) if np.isfinite(panel["value"][i - 1, j]) else None}
            for j in selected[i]]})

    # 독립 차트의 가격단위 변경이 KRX 원가격과 맞는 사건만 주식수 보정으로 공급한다.
    # 이는 현금배당·합병 권리까지 인증한 총수익 데이터가 아니다.
    corrections, suspect = [], []
    for j in union:
        factor = panel["reference_factor"][:, j]
        with np.errstate(invalid="ignore", divide="ignore"):
            ratios = np.asarray(factor[1:]) / np.asarray(factor[:-1])
        for i in np.flatnonzero(np.isfinite(ratios) & (np.abs(ratios - 1) > 0.03)) + 1:
            ratio = ratios[i - 1]
            simple = min([0.1, 0.2, 0.25, 0.5, 2, 3, 4, 5, 10, 20, 50, 100], key=lambda r: abs(ratio / r - 1))
            if abs(ratio / simple - 1) < 0.015:
                corrections.append({"scope": "SYMBOL", "key": str(codes[j]), "field": "SPLIT_RATIO",
                                    "periodKey": str(days[i]), "asOfTsMs": ts[i], "value": simple, "unit": "RATIO"})
            else:
                suspect.append({"symbol": str(codes[j]), "date": str(days[i]), "ratio": float(ratio)})
    facts = [{"scope": r["scope"], "key": r["key"], "field": r["field"], "periodKey": r["period_key"],
              "asOfTsMs": r["as_of_ts_ms"], "value": r["value"], "unit": r["unit"]}
             for r in tables["facts"] if r["key"] in symbols and r["field"] != "SPLIT_RATIO"] + corrections
    missing, nontrading, candles, delisted = [], [], [], {}
    for j in union:
        active = panel["active"][:, j]
        for i in np.flatnonzero(active[:-1] & ~active[1:]) + 1:
            delisted.setdefault(str(codes[j]), []).append(ts[i])
    # 큰 패널은 열 단위로 읽어 종목·날짜마다 메모리 매핑 객체를 반복 생성하지 않는다.
    columns = {name: np.asarray(panel[name][:, union]) for name in
               ("open", "high", "low", "close", "volume", "market", "active", "nontrading")}
    valid = np.ones(columns["open"].shape, dtype=bool)
    for name in ("open", "high", "low", "close", "volume"):
        valid &= np.isfinite(columns[name]) & (columns[name] > 0)
    for i in range(len(days)):
        nt = [str(codes[union[j]]) for j in np.flatnonzero(columns["nontrading"][i])]
        if nt:
            nontrading.append([ts[i], nt])
    for i, j in zip(*np.nonzero(columns["active"] & ~valid & ~columns["nontrading"])):
        missing.append({"symbol": str(codes[union[j]]), "date": str(days[i]), "selected": union[j] in selected[i]})
    di, cj = np.nonzero(valid)
    candle_columns = [codes[np.asarray(union)[cj]].tolist(), np.asarray(ts)[di].tolist(),
                      columns["market"][di, cj].astype(int).tolist()]
    candle_columns.extend(columns[name][di, cj].astype(float).tolist() for name in
                          ("open", "high", "low", "close", "volume"))
    candles = list(map(list, zip(*candle_columns)))
    del candle_columns, columns
    result = {"candles": candles, "facts": facts, "schedule": schedule, "macro": macro,
              "nontrading": nontrading, "delisted": delisted, "suspectActions": suspect,
              "metadata": {"universeSize": universe_size, "universeRanking": ranking, "symbols": len(union), "priceRows": len(candles),
                           "correctedUnitChanges": corrections, "missing": missing,
                           "snapshotSha256": digest(source / "market.jsonl.gz"),
                           "sources": {name: {"url": url, "sha256": digest(output / name)} for name, url in SOURCES.items()},
                           "panelHashes": {name: digest(source / "panel" / f"{name}.npy") for name in ["days", "codes", *panel]},
                           "fredSha256": digest(source / "fred.jsonl"),
                           "preparedAt": datetime.now(timezone.utc).isoformat()}}
    destination = output / f"input-{universe_size}.json.gz"
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    (output / f"input-{universe_size}-audit.json").write_text(json.dumps(result["metadata"], ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(destination), "candles": len(candles), "facts": len(facts),
                      "price_unit_changes": len(corrections), "unresolved_actions": len(suspect),
                      "selected_missing": sum(r["selected"] for r in missing)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--universe-size", type=int, default=50)
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--ranking", choices=["cap", "liquidity"], default="cap")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.fetch:
        for name, url in SOURCES.items():
            if (args.output / name).exists():
                continue
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=40) as response:
                (args.output / name).write_bytes(response.read())
    prepare(args.source, args.output, args.universe_size, args.ranking)
