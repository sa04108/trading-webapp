"""가격 입력에 원문 시점을 보존한 연간 실적 관측을 추가한다."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path


def add(stock, annual, destination):
    data = json.loads(gzip.decompress(stock.read_bytes()))
    raw = annual.read_bytes()
    source = json.loads(raw)
    if source.get("complete") is not True:
        raise ValueError("연간 공시 원문 수집이 끝나지 않았습니다")
    symbols = {c["symbol"] for c in data["candles"]}
    data["annualObservations"] = [r for r in source["observations"] if r["code"] in symbols]
    data["metadata"]["annualSource"] = {"path": str(annual), "sha256": hashlib.sha256(raw).hexdigest(),
                                       "observations": len(data["annualObservations"]), "description": source["source"]}
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    print(json.dumps(data["metadata"]["annualSource"], ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stock", type=Path)
    parser.add_argument("annual", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    add(args.stock, args.annual, args.destination)
