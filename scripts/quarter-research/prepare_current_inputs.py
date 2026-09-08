"""겹치는 실제 시세를 대조하고 현재 신호용 보통주 입력만 연장한다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path


def prepare(stock_path, etf_path, manifest_path, destination):
    stock = json.loads(gzip.decompress(stock_path.read_bytes()))
    etf = json.loads(gzip.decompress(etf_path.read_bytes()))
    manifest = json.loads(manifest_path.read_text())
    selected = {r["symbol"]: r for r in manifest["selected"]}
    days = [d for d in etf["days"] if d <= manifest["asof"]]
    first = days[-260]
    old = {(c["symbol"], c["tsMs"]): c for c in stock["candles"]
           if c["symbol"] in selected and c["tsMs"] >= int(datetime.fromisoformat(first).replace(tzinfo=timezone.utc).timestamp() * 1000)}
    overlap = 0
    for symbol, table in manifest["tables"].items():
        for raw_date, row in table.items():
            day = datetime.strptime(raw_date, "%Y%m%d").replace(tzinfo=timezone.utc)
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
    missing = []
    jumps = []
    for symbol in selected:
        history = sorted((c for (s, _), c in old.items() if s == symbol), key=lambda c: c["tsMs"])
        present = {datetime.fromtimestamp(c["tsMs"] / 1000, timezone.utc).date().isoformat() for c in history}
        missing += [{"symbol": symbol, "date": d} for d in days if stock["asof"] < d and d not in present]
        for previous, current in zip(history, history[1:]):
            day = datetime.fromtimestamp(current["tsMs"] / 1000, timezone.utc).date().isoformat()
            ratio = current["close"] / previous["close"]
            if day > stock["asof"] and not .69 <= ratio <= 1.31:
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
    stock["metadata"]["currentSources"] = {"manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                                             "stockSha256": hashlib.sha256(stock_path.read_bytes()).hexdigest(),
                                             "macroSha256": hashlib.sha256(etf_path.read_bytes()).hexdigest(),
                                             "overlapMatches": overlap}
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(stock, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    print(json.dumps({"output": str(destination), "symbols": len(selected), "candles": len(old), "overlapMatches": overlap}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("stock", "etf", "manifest", "destination"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    prepare(args.stock, args.etf, args.manifest, args.destination)
