"""보존된 시점별 KRX 대형주 입력을 같은 3개월 평가 형식으로 옮긴다."""

import argparse
from bisect import bisect_right
import gzip
import hashlib
import json
from pathlib import Path


def prepare(stock_path, etf_path, destination):
    stock_bytes = stock_path.read_bytes()
    stock = json.loads(gzip.decompress(stock_bytes))
    etf = json.loads(gzip.decompress(etf_path.read_bytes()))
    end = stock["macro"][-1]["date"]
    macro = [r for r in etf["macro"] if r["date"] <= end]
    schedule = sorted(stock["schedule"], key=lambda s: s["fromTsMs"])
    starts = [s["fromTsMs"] for s in schedule]
    members = [[m["symbol"] for m in schedule[i]["members"]] if (i := bisect_right(starts, p["tsMs"]) - 1) >= 0 else [] for p in macro]
    candles = [{"symbol": s, "tsMs": t, "market": "KR", "venue": "KOSPI" if v == 1 else "KOSDAQ", "timeframe": "1d",
                "open": o, "high": h, "low": l, "close": c, "volume": q} for s, t, v, o, h, l, c, q in stock["candles"]]
    uncertain = [{**r, "type": "unresolved"} for r in stock["suspectActions"]]
    uncertain += [{"symbol": r["key"], "date": r["periodKey"], "ratio": r["value"], "type": "inferred-unit-change"}
                  for r in stock["metadata"]["correctedUnitChanges"]]
    result = {"asof": end, "candles": candles, "days": [r["date"] for r in macro], "macro": macro,
              "members": members, "nontrading": stock["nontrading"], "facts": stock["facts"],
              "delisted": stock["delisted"], "uncertainActions": uncertain,
              "metadata": {"instrument": "stock", "universeSize": stock["metadata"]["universeSize"],
                           "sourceSha256": hashlib.sha256(stock_bytes).hexdigest(), "source": str(stock_path),
                           "corporateActions": "inferred or unresolved held events disqualify a target hit",
                           "dividends": "excluded", "macroSha256": hashlib.sha256(etf_path.read_bytes()).hexdigest()}}
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    print(json.dumps({"output": str(destination), "candles": len(candles), "macro": len(macro), "uncertainActions": len(uncertain)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stock", type=Path)
    parser.add_argument("etf", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    prepare(args.stock, args.etf, args.destination)
