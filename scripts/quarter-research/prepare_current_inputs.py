"""겹치는 실제 시세를 대조하고 현재 신호용 보통주 입력만 연장한다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path


def missing_history_sessions(days, present, nontrading):
    """첫 실제 일봉 이후의 빠진 거래일은 알려진 거래정지일만 예외로 둔다."""
    first = min(present) if present else days[0]
    return [d for d in days if d >= first and d not in present and d not in nontrading]


def prepare(stock_path, etf_path, manifest_path, destination, quarantine_unresolved=False):
    stock = json.loads(gzip.decompress(stock_path.read_bytes()))
    etf = json.loads(gzip.decompress(etf_path.read_bytes()))
    manifest = json.loads(manifest_path.read_text())
    selected = {r["symbol"]: r for r in manifest["selected"]}
    days = [d for d in etf["days"] if d <= manifest["asof"]]
    first = days[-260]
    old = {(c["symbol"], c["tsMs"]): c for c in stock["candles"]
           if c["symbol"] in selected and c["tsMs"] >= int(datetime.fromisoformat(first).replace(tzinfo=timezone.utc).timestamp() * 1000)}
    original_keys = set(old)
    nontrading = {t: set(symbols) for t, symbols in stock["nontrading"]}
    for symbol, table in manifest.get("nontradingTables", {}).items():
        if symbol not in selected:
            raise ValueError("선정 종목군 밖의 비거래 시세입니다")
        for raw_date, row in table.items():
            day = datetime.strptime(raw_date, "%Y%m%d").replace(tzinfo=timezone.utc)
            ts = int(day.timestamp() * 1000)
            if (day.date().isoformat() > manifest["asof"] or row["close"] <= 0
                    or any(row[k] != 0 for k in ("open", "high", "low", "volume"))
                    or (symbol, ts) in old or raw_date in manifest["tables"].get(symbol, {})):
                raise ValueError(f"비거래 원문과 실제 일봉이 충돌합니다: {symbol} {raw_date}")
            nontrading.setdefault(ts, set()).add(symbol)
    stock["nontrading"] = [[t, sorted(symbols)] for t, symbols in sorted(nontrading.items())]
    overlap = 0
    for symbol, table in manifest["tables"].items():
        for raw_date, row in table.items():
            day = datetime.strptime(raw_date, "%Y%m%d").replace(tzinfo=timezone.utc)
            if day.date().isoformat() > manifest["asof"]:
                raise ValueError("현재 기준일 이후의 시세가 포함됐습니다")
            key = (symbol, int(day.timestamp() * 1000))
            if key in old:
                for field in ("open", "high", "low", "close", "volume"):
                    if old[key][field] != row[field]:
                        raise ValueError(f"원자료 겹침 불일치: {symbol} {raw_date} {field}")
                overlap += 1
            old[key] = {"symbol": symbol, "tsMs": key[1], "market": "KR", "venue": selected[symbol]["market"],
                        "timeframe": "1d", **{k: row[k] for k in ("open", "high", "low", "close", "volume")}}
    if overlap < len(selected):
        raise ValueError("현재 종목 전반의 겹침 검증 표본이 부족합니다")
    quarantines = {}
    if quarantine_unresolved:
        # 미확인 기업행위 전후 가격을 연결하지 않고 사건 이후 실제 일봉부터 다시 쌓는다.
        for event in stock.get("uncertainActions", []):
            symbol, day = event["symbol"], event["date"]
            if symbol in selected and first <= day <= manifest["asof"]:
                if symbol not in quarantines or day > quarantines[symbol]["date"]:
                    quarantines[symbol] = event
        old = {key: bar for key, bar in old.items() if key[0] not in quarantines
               or key[1] >= int(datetime.fromisoformat(quarantines[key[0]]["date"]).replace(tzinfo=timezone.utc).timestamp() * 1000)}
    missing = []
    jumps = []
    for symbol in selected:
        history = sorted((c for (s, _), c in old.items() if s == symbol), key=lambda c: c["tsMs"])
        present = {datetime.fromtimestamp(c["tsMs"] / 1000, timezone.utc).date().isoformat() for c in history}
        known_nontrading = {datetime.fromtimestamp(t / 1000, timezone.utc).date().isoformat()
                            for t, symbols in stock["nontrading"] if symbol in symbols}
        missing += [{"symbol": symbol, "date": d} for d in
                    missing_history_sessions([d for d in days if d >= first], present, known_nontrading)]
        for previous, current in zip(history, history[1:]):
            day = datetime.fromtimestamp(current["tsMs"] / 1000, timezone.utc).date().isoformat()
            ratio = current["close"] / previous["close"]
            if (symbol, current["tsMs"]) not in original_keys and not .69 <= ratio <= 1.31:
                jumps.append({"symbol": symbol, "date": day, "ratio": ratio})
    if missing or jumps:
        raise ValueError(f"현재 연장 자료의 누락 또는 단위 변화 확인 필요: {missing} {jumps}")
    stock["asof"] = manifest["asof"]
    stock["candles"] = sorted(old.values(), key=lambda c: (c["symbol"], c["tsMs"]))
    stock["days"] = [d for d in days if d >= first]
    stock["macro"] = [m for m in etf["macro"] if m["date"] in stock["days"]]
    stock["members"] = [list(selected) for _ in stock["days"]]
    stock["currentSymbols"] = manifest["selected"]
    stock["metadata"]["usage"] = "current signal only; today's universe must not be used for historical performance"
    stock["metadata"]["currentHistoryQuarantines"] = list(quarantines.values())
    stock["metadata"]["currentSources"] = {"manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                                             "stockSha256": hashlib.sha256(stock_path.read_bytes()).hexdigest(),
                                             "macroSha256": hashlib.sha256(etf_path.read_bytes()).hexdigest(),
                                             "overlapMatches": overlap, "addedCandleCount": len(set(old) - original_keys),
                                             "warmupCalendarChecked": True}
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(stock, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    print(json.dumps({"output": str(destination), "symbols": len(selected), "candles": len(old), "overlapMatches": overlap, "addedCandleCount": len(set(old) - original_keys),
                                             "warmupCalendarChecked": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("stock", "etf", "manifest", "destination"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--quarantine-unresolved", action="store_true", help="현재 신호에서 미확인 기업행위 이후의 실제 가격만 사용")
    args = parser.parse_args()
    prepare(args.stock, args.etf, args.manifest, args.destination, args.quarantine_unresolved)
