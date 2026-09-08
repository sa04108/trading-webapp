"""현재 신호 전용 입력에 같은 날짜의 공개 시가총액과 검증된 순이익·자본을 붙인다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path


def add(stock, financial, manifest_path, destination):
    data = json.loads(gzip.decompress(stock.read_bytes()))
    source = json.loads(financial.read_text())
    manifest = json.loads(manifest_path.read_text())
    if not data["metadata"].get("usage") or manifest["asof"] != data["asof"]:
        raise ValueError("같은 기준일의 현재 신호 전용 입력이 필요합니다")
    if source["collection"].get("complete") is not True:
        raise ValueError("재무 원문 수집이 완료되지 않았습니다")
    ts_ms = int(datetime.fromisoformat(data["asof"]).replace(tzinfo=timezone.utc).timestamp() * 1000)
    closes = {r["symbol"]: r["close"] for r in data["candles"] if r["tsMs"] == ts_ms}
    selected = {r["symbol"]: r for r in manifest["selected"]}
    if set(selected) != set(closes):
        raise ValueError("현재 종목군과 종가 입력이 다릅니다")
    values = {}
    for symbol, row in selected.items():
        cap = float(row["marketCap"])
        if (row["tradedAt"][:10] != data["asof"] or row["close"] != closes[symbol]
                or not cap.is_integer() or not 0 < cap <= 2 ** 53 - 1):
            raise ValueError(f"현재 시가총액·가격·기준일을 확인할 수 없습니다: {symbol}")
        values[symbol] = str(int(cap))
    data["capitalizations"] = [{"tsMs": ts_ms, "asof": data["asof"], "values": values}]
    data["valuationObservations"] = [r for r in source["observations"] if r["symbol"] in selected]
    data["metadata"]["valuationSources"] = {"inputSha256": hashlib.sha256(stock.read_bytes()).hexdigest(),
                                             "financialSha256": hashlib.sha256(financial.read_bytes()).hexdigest(),
                                             "capManifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                                             "capTiming": "same signal day final close; future fills are not generated"}
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    print(json.dumps({"symbols": len(selected), "observations": len(data["valuationObservations"]), "asof": data["asof"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("stock", "financial", "manifest", "destination"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    add(args.stock, args.financial, args.manifest, args.destination)
