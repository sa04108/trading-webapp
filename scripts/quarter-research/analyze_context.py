"""결과를 보기 전에 정한 현재 환경 조건별 표본과 수익을 함께 보존한다."""

import argparse
from bisect import bisect_right
import csv
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path

import numpy as np


def export_history(path):
    with path.open() as stream:
        rows = list(csv.DictReader(stream))
    field = next(k for k in rows[0] if k != "observation_date")
    values = {r["observation_date"]: float(r[field]) for r in rows if r[field] not in ("", ".")}
    result = []
    for day, value in sorted(values.items()):
        observed = date.fromisoformat(day)
        previous = values.get(observed.replace(year=observed.year - 1).isoformat())
        if previous is not None and previous > 0:
            result.append({"observed": day, "available": (observed + timedelta(days=90)).isoformat(),
                           "value": value, "yoy": value / previous - 1})
    return result


def known_export(rows, day):
    index = bisect_right([r["available"] for r in rows], day) - 1
    return rows[index] if index >= 0 else None


def nonoverlapping(rows):
    result = []
    last = ""
    for row in sorted(rows, key=lambda r: r["start"]):
        if row["start"] > last:
            result.append(row)
            last = row["end"]
    return result


def summarize(rows):
    if not rows:
        return {"count": 0}
    values = np.array([r["returnPct"] for r in rows])
    return {"count": len(rows), "targetHits": sum(r["targetReached"] for r in rows),
            "targetFrequencyPct": float(np.mean([r["targetReached"] for r in rows]) * 100),
            "medianPct": float(np.median(values)), "p10Pct": float(np.quantile(values, .1)),
            "worstPct": float(min(values)), "lossFrequencyPct": float(np.mean(values < 0) * 100),
            "worstDrawdownPct": min(r["drawdownPct"] for r in rows),
            "unclosed": sum(not r["closed"] for r in rows)}


def analyze(root, directories, output):
    export_path = root / "sources-20260908/fred-XTEXVA01KRM667N.csv"
    exports = export_history(export_path)
    records = []
    for directory in directories:
        for source in sorted((root / directory).glob("*__summary.json")):
            trial = json.loads(source.read_text())
            selections = {k: [] for k in ("all", "export_growth", "recovery", "export_recovery")}
            for row in trial["windows"]:
                m = row["startState"]
                export = known_export(exports, row["start"])
                recovery = m["kospiRet20"] > 0 and m["kospiRet60"] < 0
                growth = export is not None and export["yoy"] > .10
                enriched = {**row, "knownExport": export}
                for name, keep in (("all", True), ("export_growth", growth),
                                   ("recovery", recovery), ("export_recovery", growth and recovery)):
                    if keep:
                        selections[name].append(enriched)
            for condition, rows in selections.items():
                records.append({"directory": directory, "candidate": trial["candidate"], "stage": trial["stage"],
                                "condition": condition, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                                "all": summarize(rows), "nonoverlapping": summarize(nonoverlapping(rows)),
                                "windows": rows})
    result = {"asof": "2026-09-08", "exportSourceSha256": hashlib.sha256(export_path.read_bytes()).hexdigest(),
              "exportAvailability": "observation month start plus 90 calendar days; latest vintage, not certified point-in-time",
              "currentKnownExport": known_export(exports, "2026-09-08"), "records": records}
    output.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
    print(json.dumps({"output": str(output), "records": len(records), "currentKnownExport": result["currentKnownExport"]}))
    for r in records:
        if r["condition"] == "export_recovery" and r["candidate"]["id"] in ("momentum-20-5-monthly", "recovery-60-3-monthly", "quality-60-15"):
            print(json.dumps({k: r[k] for k in ("directory", "condition", "all", "nonoverlapping")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("directories", nargs="+")
    args = parser.parse_args()
    analyze(args.root, args.directories, args.output)
