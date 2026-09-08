"""회사 공시로 확인한 거래정지 구간만 별도 연구 입력의 체결 제한에 보강한다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import html
import json
from pathlib import Path
import re


def apply(input_path, evidence_path, destination):
    data = json.loads(gzip.decompress(input_path.read_bytes()))
    evidence = json.loads(evidence_path.read_text())
    source = Path(evidence["sourcePath"]).read_bytes()
    if hashlib.sha256(source).hexdigest() != evidence["sourceSha256"]:
        raise ValueError("거래정지 근거 원문 해시가 다릅니다")
    text = re.sub(r"\s+", " ", html.unescape(re.sub("<[^>]+>", " ", source.decode("utf-8"))))
    if any(phrase not in text for phrase in evidence["requiredPhrases"]):
        raise ValueError("원문에서 거래정지 기간을 확인할 수 없습니다")
    symbol = evidence["symbol"]
    nontrading = {t: set(symbols) for t, symbols in data["nontrading"]}
    existing_bars = {r["tsMs"] for r in data["candles"] if r["symbol"] == symbol}
    added = []
    for day in data["days"]:
        if evidence["from"] <= day <= evidence["through"]:
            ts_ms = int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp() * 1000)
            if ts_ms in existing_bars:
                raise ValueError("정지 구간에 유효한 실제 일봉이 있어 확인이 더 필요합니다")
            values = nontrading.setdefault(ts_ms, set())
            if symbol not in values:
                added.append(day)
            values.add(symbol)
    data["nontrading"] = [[t, sorted(symbols)] for t, symbols in sorted(nontrading.items())]
    data["metadata"]["verifiedHalt"] = {**evidence, "addedDates": added,
                                        "inputSha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
                                        "use": "당시 실제 체결 가능 여부의 복원이며 이후 공시 내용을 과거 선정 신호로 제공하지 않는다"}
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    print(json.dumps({"symbol": symbol, "addedNontradingDates": added, "priceRowsUnchanged": len(data["candles"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "evidence", "destination"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    apply(args.input, args.evidence, args.destination)
