"""시장 snapshot에서 과거 시점 종목·가격 패널과 수익률 계산 전 데이터 감사를 만든다."""

import argparse
import json
from pathlib import Path
import sqlite3

import numpy as np
import pandas as pd


def prepare(database, destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)
    days = np.array([r[0] for r in connection.execute("SELECT date FROM symbol_master_trading_days ORDER BY date")])
    codes = np.array([r[0] for r in connection.execute("SELECT DISTINCT short_code FROM krx_daily_bars ORDER BY short_code")])
    dates_index = pd.Index(days)
    codes_index = pd.Index(codes)
    shape = (len(days), len(codes))
    panels = {field: np.full(shape, np.nan) for field in ("open", "high", "low", "close", "volume", "cap", "value")}
    unknown_dates = set()
    for chunk in pd.read_sql_query("SELECT short_code,date,open,high,low,close,volume FROM krx_daily_bars", connection, chunksize=100000):
        di = dates_index.get_indexer(chunk.date)
        ci = codes_index.get_indexer(chunk.short_code)
        valid = (di >= 0) & (ci >= 0)
        unknown_dates.update(chunk.date[di < 0].tolist())
        for field in ("open", "high", "low", "close", "volume"):
            panels[field][di[valid], ci[valid]] = chunk[field].to_numpy()[valid]
    print("가격 패널 구성 완료", flush=True)

    master = pd.read_sql_query("SELECT * FROM symbol_master_versions ORDER BY valid_from_date,standard_code", connection)
    common = np.zeros(shape, dtype=bool)
    active = np.zeros(shape, dtype=bool)
    market = np.zeros(shape, dtype=np.int8)
    isin_codes = dict(zip(master.standard_code, master.short_code))
    epochs = {}
    for row in master.itertuples():
        ci = codes_index.get_indexer([row.short_code])[0]
        if ci < 0:
            continue
        start = int(np.searchsorted(days, row.valid_from_date))
        stop = int(np.searchsorted(days, row.valid_to_date)) if row.valid_to_date else len(days)
        active[start:stop, ci] = True
        common[start:stop, ci] = row.instrument_type == "COMMON_STOCK"
        market[start:stop, ci] = 1 if row.market == "KOSPI" else 2
        epochs.setdefault(row.short_code, {}).setdefault(row.standard_code, row.valid_from_date)
    reused_codes = {}
    for code, history in epochs.items():
        if len(history) > 1:
            boundary = sorted(history.values())[1]
            reused_codes[code] = boundary
            common[np.searchsorted(days, boundary):, codes_index.get_indexer([code])[0]] = False

    for chunk in pd.read_sql_query("SELECT * FROM daily_selection_metrics", connection, chunksize=100000):
        di = dates_index.get_indexer(chunk.date)
        ci = codes_index.get_indexer(chunk.standard_code.map(isin_codes).fillna(""))
        valid = (di >= 0) & (ci >= 0)
        panels["cap"][di[valid], ci[valid]] = pd.to_numeric(chunk.market_cap_krw, errors="coerce").to_numpy()[valid]
        panels["value"][di[valid], ci[valid]] = pd.to_numeric(chunk.trading_value_krw, errors="coerce").to_numpy()[valid]
    print("시점별 종목과 선정 지표 구성 완료", flush=True)

    nontrading = np.zeros(shape, dtype=bool)
    nt = pd.read_sql_query("SELECT * FROM krx_non_trading_days", connection)
    nt_code = "short_code" if "short_code" in nt else "code"
    di = dates_index.get_indexer(nt.date)
    ci = codes_index.get_indexer(nt[nt_code])
    valid = (di >= 0) & (ci >= 0)
    nontrading[di[valid], ci[valid]] = True
    # 거래불가일의 공식 종가는 평가와 지표에만 사용하며 시가·거래량은 만들지 않는다.
    panels["close"][di[valid], ci[valid]] = nt.last_close.to_numpy()[valid]

    splits = pd.read_sql_query("SELECT * FROM facts WHERE field='SPLIT_RATIO' ORDER BY as_of_ts_ms,value", connection)
    conflicts = splits.groupby(["key", "period_key"]).value.nunique()
    split_ratio = np.ones(shape)
    for row in splits.drop_duplicates(["key", "period_key"]).itertuples():
        ci = codes_index.get_indexer([row.key])[0]
        di = int(np.searchsorted(days, row.period_key))
        if ci >= 0 and di < len(days):
            if not np.isfinite(row.value) or row.value <= 0:
                raise ValueError("유효하지 않은 분할 비율")
            split_ratio[di, ci] *= row.value
    adjusted_close = pd.DataFrame(np.where(panels["close"] > 0, panels["close"], np.nan)).ffill().to_numpy() * np.cumprod(split_ratio, axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        change = adjusted_close[1:] / adjusted_close[:-1] - 1
    abnormal = (np.abs(change) > 0.35) & common[1:] & (panels["volume"][1:] > 0)
    anomalies = []
    for di, ci in np.argwhere(abnormal):
        di += 1
        anomalies.append({"date": str(days[di]), "code": str(codes[ci]), "adjusted_return": float(change[di - 1, ci]), "split_ratio": float(split_ratio[di, ci])})
    missing = active & ~np.isfinite(panels["close"]) & ~nontrading
    positive_ohlc = np.isfinite(panels["open"]) & (panels["open"] > 0)
    invalid_ohlc = positive_ohlc & ((panels["low"] > np.minimum(panels["open"], panels["close"])) | (panels["high"] < np.maximum(panels["open"], panels["close"])))
    audit = {
        "days": len(days), "codes": len(codes), "from": str(days[0]), "to": str(days[-1]),
        "unknown_price_dates": sorted(unknown_dates),
        "common_stock_counts": {str(days[i]): int(common[i].sum()) for i in range(0, len(days), 252)},
        "missing_active_without_nontrading_count": int(missing.sum()),
        "invalid_ohlc_count": int(invalid_ohlc.sum()),
        "conflicting_split_events": int((conflicts > 1).sum()),
        "reused_codes": reused_codes,
        "large_adjusted_changes": anomalies,
        "fundamental_fields": [list(r) for r in connection.execute("SELECT field,count(*),count(distinct key),min(period_key),max(period_key) FROM facts GROUP BY field")],
    }
    (destination / "data-audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    panels.update({"days": days, "codes": codes, "common": common, "active": active, "market": market, "nontrading": nontrading, "split": split_ratio, "adjusted": adjusted_close, "missing": missing})
    for name, panel in panels.items():
        np.save(destination / f"{name}.npy", panel, allow_pickle=False)
    connection.close()
    print(json.dumps({k: v for k, v in audit.items() if k not in ("large_adjusted_changes", "fundamental_fields", "reused_codes")}, ensure_ascii=False), flush=True)
    print(f"35% 초과 조정가격 변화: {len(anomalies)}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database")
    parser.add_argument("destination")
    args = parser.parse_args()
    prepare(args.database, args.destination)
