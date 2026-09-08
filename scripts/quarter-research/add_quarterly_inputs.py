"""기존 가격 입력을 보존하고 검증한 분기 관측과 출처 해시를 별도 입력에 붙인다."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path


def add(stock, quarterly, destination):
    price_bytes, quarter_bytes = stock.read_bytes(), quarterly.read_bytes()
    data = json.loads(gzip.decompress(price_bytes))
    source = json.loads(quarter_bytes)
    if source["collection"].get("complete") is not True:
        raise ValueError("분기 원문 수집이 끝나지 않았습니다")
    symbols = {c["symbol"] for c in data["candles"]}
    data["quarterlyObservations"] = [r for r in source["observations"] if r["symbol"] in symbols]
    data["metadata"]["quarterlySource"] = {
        "path": str(quarterly), "sha256": hashlib.sha256(quarter_bytes).hexdigest(),
        "priceInputSha256": hashlib.sha256(price_bytes).hexdigest(),
        "observations": len(data["quarterlyObservations"]), "note": source["note"]}
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    print(json.dumps(data["metadata"]["quarterlySource"], ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("stock", "quarterly", "destination"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    add(args.stock, args.quarterly, args.destination)
