"""성과를 읽지 않고 알려진 시작일 시장 조건으로 진입 날짜를 고정한다."""

import argparse
import calendar
from datetime import date, timedelta
import gzip
import hashlib
import json
from pathlib import Path


def end_of_quarter(start):
    current = date.fromisoformat(start)
    month = current.month + 3
    year, month = current.year + (month - 1) // 12, (month - 1) % 12 + 1
    return (date(year, month, min(current.day, calendar.monthrange(year, month)[1])) - timedelta(days=1)).isoformat()


def prepare(input_path, config, destination):
    raw = input_path.read_bytes()
    data = json.loads(gzip.decompress(raw))
    if data["metadata"].get("usage"):
        raise ValueError("과거 시점별 종목 입력이 필요합니다")
    source = hashlib.sha256(raw).hexdigest()
    stages = []
    for stage, first, last in (("development", "2016-01-01", "2019-12-31"),
                               ("validation", "2020-01-01", "2023-12-31"),
                               ("confirmation", "2024-01-01", min(data["asof"], "2026-09-08"))):
        conditions = []
        for threshold in (.25, .30, .35):
            rows = [{"start": m["date"], "end": end_of_quarter(m["date"]), "startState": m} for m in data["macro"]
                    if first <= m["date"] <= last and end_of_quarter(m["date"]) <= last
                    and m["kospiVol20"] >= threshold and m["kospiRet20"] > 0 and m["kospi"] > m["kospiSma20"]]
            independent, end = [], ""
            for row in rows:
                if row["start"] > end:
                    independent.append(row["start"])
                    end = row["end"]
            conditions.append({"threshold": threshold, "count": len(rows), "nonoverlappingStarts": independent, "windows": rows})
        stages.append({"stage": stage, "conditions": conditions})
        options = {"resetUncertainHistory": True, "starts": [r["start"] for r in conditions[0]["windows"]],
                   "dateSelection": {"minimumVolatility": .25, "positiveReturn20": True, "aboveSma20": True, "inputSha256": source}}
        (config / f"entry-{stage}-options.json").write_text(json.dumps(options, ensure_ascii=False, indent=2) + "\n")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps({"inputSha256": source, "stages": stages,
                                      "note": "성과 파일을 읽지 않고 조건과 만기가 완성된 시작일을 선택했다. 중첩 계좌는 독립 표본이 아니다."}, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps([{ "stage": r["stage"], "counts": [c["count"] for c in r["conditions"]]} for r in stages]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "config", "destination"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    prepare(args.input, args.config, args.destination)
