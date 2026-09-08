"""2011년 KRX 원문과 공개 거시 관측으로 별도 회복 전략 입력을 만든다."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re

import numpy as np
import pandas as pd

from prepare_entry_dates import end_of_quarter
from prepare_inputs import lagged_values


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def number(value):
    return float(str(value).replace(",", "")) if value not in (None, "", "-", ".") else np.nan


def common_stock(row):
    group = row["SECUGRP_NM"]
    if group in {"부동산투자회사", "주식예탁증권", "주식예탁증서", "수익증권", "투자회사", "선박투자회사", "사회간접자본투융자회사",
                 "신주인수권증권", "신주인수권증서", "ETF", "ETN", "ELW", "외국주권"}:
        return False
    if group != "주권":
        raise ValueError(f"미확인 증권 분류: {group}")
    if "SPAC" in row.get("SECT_TP_NM", "") or "스팩" in row["ISU_NM"]:
        return False
    kind = row["KIND_STKCERT_TP_NM"]
    if kind in {"구형우선주", "신형우선주", "우선주", "종류주권"}:
        return False
    if kind != "보통주":
        raise ValueError(f"미확인 주권 분류: {kind}")
    return True


def reference_discontinuity(previous_close, close, change):
    reference = close - change
    if not all(np.isfinite(v) for v in (previous_close, close, change)) or previous_close <= 0 or reference <= 0:
        return None
    return reference / previous_close if abs(reference - previous_close) > .01 else None


def monthly_members(days, codes, common, liquidity, volume, cap, limit=200):
    """월간 선정에는 당일이나 미래의 시가총액·거래 가능 상태를 쓰지 않는다."""
    members, selected = [], []
    for i, day in enumerate(days):
        if i > 20 and (i == 21 or day[:7] != days[i - 1][:7]):
            valid = common[i - 1] & (liquidity[i - 1] >= 1e9) & (volume[i - 1] > 0) & (cap[i - 1] > 0)
            selected = [codes[j] for j in sorted(np.flatnonzero(valid), key=lambda j: (-cap[i - 1, j], codes[j]))[:limit]]
        members.append(list(selected))
    return members


def load_raw(root):
    daily, basic, seen, sources = {}, {}, set(), {}
    columns = ("TDD_OPNPRC", "TDD_HGPRC", "TDD_LWPRC", "TDD_CLSPRC", "ACC_TRDVOL", "ACC_TRDVAL", "MKTCAP", "CMPPREVDD_PRC")
    for name in ("krx-sample.jsonl.gz", "krx-daily.jsonl.gz", "krx-basic.jsonl.gz"):
        path = root / name
        sources[str(path)] = digest(path)
        last = None
        with gzip.open(path, "rt") as stream:
            for line in stream:
                record = json.loads(line)
                last = record
                if "response" not in record:
                    continue
                key = (record["date"], record["market"], record["kind"])
                if key in seen:
                    raise ValueError("원문 요청 중복")
                seen.add(key)
                date = pd.Timestamp(record["date"]).strftime("%Y-%m-%d")
                target = (daily if record["kind"] == "daily" else basic).setdefault(date, {})
                rows = record["response"].get("OutBlock_1")
                if not isinstance(rows, list) or not rows:
                    raise ValueError("빈 원문 요청")
                for row in rows:
                    code = row["ISU_CD"] if record["kind"] == "daily" else row["ISU_SRT_CD"]
                    if code in target:
                        raise ValueError(f"같은 날짜 종목 중복: {date} {code}")
                    if record["kind"] == "daily":
                        if row["BAS_DD"] != record["date"]:
                            raise ValueError("요청일과 시세 기준일 불일치")
                        target[code] = (*[number(row[k]) for k in columns], record["market"])
                    else:
                        target[code] = (row["ISU_CD"], common_stock(row), row["ISU_ABBRV"], record["market"])
        if not last or last.get("complete") is not True:
            raise ValueError(f"끝나지 않은 수집 원문: {path}")
    return daily, basic, seen, sources


def build_macro(root, days, closes, ages):
    source = root.parent / "sources-20260908"
    indexes = {}
    for code in ("KOSPI", "KOSDAQ"):
        rows = json.loads((source / f"index-{code}.json").read_text())
        indexes[code] = pd.Series({pd.Timestamp(r["localDate"]).strftime("%Y-%m-%d"): r["closePrice"] for r in rows}).sort_index()
    kp, kq = indexes["KOSPI"], indexes["KOSDAQ"]
    macro = pd.DataFrame(index=days)
    macro["kospi"] = kp
    for n in (20, 60, 120):
        macro[f"kospiSma{n}"] = kp.rolling(n).mean()
        macro[f"kospiRet{n}"] = kp.pct_change(n)
    macro["kosdaqRet60"] = kq.pct_change(60)
    macro["kospiVol20"] = kp.pct_change().rolling(20).std() * np.sqrt(252)
    macro["kospiDrawdown60"] = kp / kp.rolling(60).max() - 1
    frame = pd.DataFrame(closes, index=days)
    macro["breadth60"] = ((frame > frame.rolling(60).mean()) & (ages >= 126)).sum(axis=1) / np.maximum(1, (ages >= 126).sum(axis=1))
    observations = {}
    with gzip.open(root / "fred-api.jsonl.gz", "rt") as stream:
        last = None
        for line in stream:
            record = json.loads(line)
            last = record
            if "response" in record:
                observations[record["series"]] = [(r["date"], number(r["value"])) for r in record["response"]["observations"]]
        if not last or last.get("complete") is not True:
            raise ValueError("FRED 수집 미완료")
    for name, code in (("oil", "DCOILBRENTEU"), ("wti", "DCOILWTICO"), ("fx", "DEXKOUS"), ("fed", "DFF"), ("us10y", "DGS10")):
        values, observed = lagged_values(observations[code], days, lag_days=7)
        macro[name], macro[f"{name}Date"] = values, observed
        macro[f"{name}Ret20"] = pd.Series(values, index=days).pct_change(20)
    vix = pd.read_csv(source / "vix.csv")
    macro["vix"], macro["vixDate"] = lagged_values(zip(pd.to_datetime(vix.DATE).dt.strftime("%Y-%m-%d"), vix.CLOSE), days)
    rates = re.findall(r'<td class="fb">(\d{4})</td>\s*<td[^>]*>\s*(\d{2})월\s*(\d{2})일\s*</td>\s*<td[^>]*>\s*([\d.]+)', (source / "bok.html").read_text())
    macro["rate"], macro["rateDate"] = lagged_values([(f"{y}-{m}-{d}", v) for y, m, d, v in rates], days)
    macro["rateChange60"] = macro.rate.diff(60)
    if not np.isfinite(macro.select_dtypes(include="number").loc["2011-09-07":].to_numpy()).all():
        raise ValueError("평가 구간 거시 관측 불완전")
    return [{"date": d, "tsMs": int(pd.Timestamp(d, tz="UTC").timestamp() * 1000), **{k: (None if isinstance(v, float) and not np.isfinite(v) else v) for k, v in macro.loc[d].to_dict().items()}} for d in days]


def prepare(root, output, config):
    daily, basic, seen, sources = load_raw(root)
    days = sorted(daily)
    if days != sorted(basic) or len(seen) != len(days) * 4:
        raise ValueError("두 시장 일봉·기본정보 날짜가 완전하지 않습니다")
    expected = [pd.Timestamp(r["localDate"]).strftime("%Y-%m-%d") for r in json.loads((root.parent / "sources-20260908/index-KOSPI.json").read_text())
                if days[0].replace("-", "") <= r["localDate"] <= days[-1].replace("-", "")]
    if days != expected:
        raise ValueError("지수 달력과 KRX 수집 날짜 불일치")
    codes = sorted(set(code for day in daily.values() for code in day))
    index = {code: j for j, code in enumerate(codes)}
    shape = (len(days), len(codes))
    matrices = {k: np.full(shape, np.nan) for k in ("open", "high", "low", "close", "volume", "value", "cap", "change")}
    active, common = np.zeros(shape, dtype=bool), np.zeros(shape, dtype=bool)
    for i, date in enumerate(days):
        for code, row in daily[date].items():
            j = index[code]
            if code not in basic[date]:
                raise ValueError(f"일봉 종목의 당시 기본정보 누락: {date} {code}")
            for k, value in zip(matrices, row):
                matrices[k][i, j] = value
            active[i, j], common[i, j] = True, basic[date][code][1]
    liquidity = pd.DataFrame(matrices["value"]).rolling(20, min_periods=20).mean().to_numpy()
    members = monthly_members(days, codes, common, liquidity, matrices["volume"], matrices["cap"])
    union = sorted({code for row in members for code in row})
    candles, nontrading, events, delisted, missing = [], {}, [], {}, []
    for code in union:
        j, previous, previous_identity, was_active = index[code], np.nan, None, False
        for i, date in enumerate(days):
            ts = int(pd.Timestamp(date, tz="UTC").timestamp() * 1000)
            if not active[i, j]:
                if was_active:
                    delisted.setdefault(code, []).append(ts)
                    events.append({"symbol": code, "date": date, "ratio": 1, "type": "상장 상태 이탈"})
                was_active = False
                continue
            was_active = True
            row = daily[date][code]
            o, h, l, c, v, _, _, change, market = row
            identity = basic[date][code][0]
            ratio = reference_discontinuity(previous, c, change)
            if ratio is not None:
                events.append({"symbol": code, "date": date, "ratio": ratio, "type": "KRX 전일대비 기준가격 불연속"})
            if previous_identity is not None and identity != previous_identity:
                events.append({"symbol": code, "date": date, "ratio": 1, "type": "표준코드 변경"})
            previous, previous_identity = c, identity
            if v == 0 and c > 0:
                nontrading.setdefault(ts, []).append(code)
                continue
            if not all(np.isfinite(x) for x in (o, h, l, c, v)) or not (0 < l <= min(o, c) <= max(o, c) <= h and v > 0):
                missing.append({"symbol": code, "date": date, "ohlcv": [None if not np.isfinite(x) else x for x in (o, h, l, c, v)]})
                continue
            candles.append({"symbol": code, "tsMs": ts, "market": "KR", "venue": market, "timeframe": "1d", "open": o, "high": h, "low": l, "close": c, "volume": v})
    diagnostics = {"from": days[0], "through": days[-1], "days": len(days), "requests": len(seen), "historicalUnion": len(union),
                   "candles": len(candles), "uncertainEvents": len(events), "missing": missing, "events": events}
    (root / "input-diagnostics.json").write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2) + "\n")
    if missing:
        raise ValueError(f"확인 필요한 실제 일봉 {len(missing)}개: input-diagnostics.json")
    macro = build_macro(root, days, matrices["close"], np.cumsum(np.isfinite(matrices["close"]) & (matrices["volume"] > 0), axis=0))
    for p in [root / "fred-api.jsonl.gz", *[root.parent / "sources-20260908" / name for name in ("index-KOSPI.json", "index-KOSDAQ.json", "vix.csv", "bok.html")]]:
        sources[str(p)] = digest(p)
    result = {"asof": days[-1], "days": days, "candles": sorted(candles, key=lambda r: (r["tsMs"], r["symbol"])), "macro": macro,
              "members": members, "nontrading": [[t, sorted(s)] for t, s in sorted(nontrading.items())], "facts": [], "delisted": delisted, "uncertainActions": events,
              "metadata": {"instrument": "stock", "initialCash": 100_000_000, "sourceSha256": sources, "historicalUniverse": "전일 보통주·실제 거래대금과 월별 시가총액 200개",
                           "corporateActions": "실제 가격 보존; 기준가격 불연속·정체성 변경·상장 이탈은 불확실 사건이며 보유 계좌 실패", "dividends": "계좌와 신호에서 제외",
                           "macroAvailability": "FRED 관측 +7일, VIX·BOK +1일; 최신 빈티지의 과거 관측"}}
    with gzip.GzipFile(filename=str(output), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    for threshold in (.25, .30, .35):
        starts = [m["date"] for m in macro if m["date"] >= "2011-01-01" and end_of_quarter(m["date"]) <= days[-1]
                  and m["kospiVol20"] >= threshold and m["kospiRet20"] > 0 and m["kospi"] > m["kospiSma20"]]
        options = {"resetUncertainHistory": True, "starts": starts, "dateSelection": {"minimumVolatility": threshold, "positiveReturn20": True,
                   "aboveSma20": True, "inputSha256": digest(output)}}
        (config / f"earlier-{round(threshold * 100)}-options.json").write_text(json.dumps(options, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in diagnostics.items() if k not in ("events", "missing")}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    prepare(args.root, args.output, args.config)
