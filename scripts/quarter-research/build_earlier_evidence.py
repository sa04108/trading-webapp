"""추가 과거 계좌·원문·조건별 집계를 검증하고 공개용 요약을 만든다."""

import argparse
import csv
import hashlib
import gzip
import json
import math
from pathlib import Path

from analyze_context import nonoverlapping, summarize
from prepare_entry_dates import end_of_quarter


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    config = Path(__file__).parent / "configs"
    experiments = json.loads((config / "earlier-experiments.json").read_text())
    audit = json.loads((root / "earlier/date-audit.json").read_text())
    if digest(root / "sources-20260908/index-KOSPI.json") != audit["sourceSha256"]:
        raise ValueError("날짜를 고정한 지수 원문 해시가 다릅니다")
    with gzip.open(root / "earlier/stock-200-input.json.gz", "rt") as stream:
        candles = json.load(stream)["candles"]
    venues = {(c["symbol"], c["tsMs"]): c["venue"] for c in candles}
    grouped, files, sources = {}, [], set()
    for experiment in experiments:
        options_path, selection = config / experiment["options"], config / experiment["selection"]
        options = json.loads(options_path.read_text())
        input_path = root / experiment["input"]
        input_hash, options_hash = digest(input_path), digest(options_path)
        sources.update((options_path, selection, input_path))
        for candidate in json.loads(selection.read_text()):
            summary_path = root / experiment["directory"] / f'{candidate["id"]}__summary.json'
            trial = json.loads(summary_path.read_text())
            if (trial["candidate"] != candidate or trial["stage"] != "earlier" or trial["options"] != options
                    or trial["inputSha256"] != input_hash or trial["optionsSha256"] != options_hash
                    or [w["start"] for w in trial["windows"]] != options["starts"]):
                raise ValueError("고정한 입력·날짜·후보와 일치하지 않습니다")
            for window in trial["windows"]:
                path = summary_path.with_name(f'{candidate["id"]}__{window["start"]}.json')
                run = json.loads(path.read_text())
                p = {"formationDays": candidate["parameters"]["formationDays"], "topN": 3, "targetAnnualVolatility": .3,
                     "positionStopPct": candidate["parameters"].get("positionStopPct", 8)}
                if (run.get("status") == "failed" or run["summary"] != window or run["candidate"] != candidate or run["parameters"] != p
                        or run["stage"] != "earlier" or run["inputSha256"] != input_hash or run["optionsSha256"] != options_hash
                        or run["options"] != options or run["seed"] != 204 or run["slippageBps"] != 5
                        or run["risk"]["initialCash"] != 100_000_000 or run["risk"]["targetPct"] != 10.5 or run["risk"]["stopPct"] != 10
                        or run["engineVersion"] != "2.12.0" or run["strategyVersion"] != "0.1.0+history-reset.1"
                        or window["end"] != end_of_quarter(window["start"])
                        or run["result"]["metrics"]["totalReturnPct"] != window["returnPct"]
                        or (len(run["result"]["openPositions"]) == 0) != window["closed"]
                        or window["targetReached"] != (window["closed"] and not window["affectedActions"] and window["returnPct"] >= 10)):
                    raise ValueError(f"추가 과거 계좌의 실행 설정·성과 불일치: {path}")
                for fill in run["result"]["fills"]:
                    venue = venues[(fill["symbol"], fill["tsMs"])]
                    tax = (2 * math.floor(fill["grossAmount"] * .0015) if venue == "KOSPI" else math.floor(fill["grossAmount"] * .003)) if fill["side"] == "SELL" else 0
                    if (not math.isclose(fill["commission"], fill["grossAmount"] * .00015, rel_tol=1e-10, abs_tol=1e-7)
                            or fill["tax"] != tax):
                        raise ValueError("2011년 비용·매도세율과 실제 체결 비용 불일치")
                files.append({"file": str(path.relative_to(root)), "sha256": digest(path)})
            for key, rows in (("all", trial["windows"]), ("nonoverlapping", nonoverlapping(trial["windows"]))):
                actual = summarize(rows)
                if set(actual) != set(trial[key]) or any(not math.isclose(v, trial[key][k], rel_tol=1e-10, abs_tol=1e-8) for k, v in actual.items()):
                    raise ValueError("원본 계좌로 재계산한 통계 불일치")
            files.append({"file": str(summary_path.relative_to(root)), "sha256": digest(summary_path)})
            grouped.setdefault(candidate["id"], []).extend(trial["windows"])
    records = []
    compact_fields = ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "affectedActions", "trades", "fills", "riskEvents", "startState")
    for candidate, windows in grouped.items():
        windows.sort(key=lambda w: w["start"])
        if len({w["start"] for w in windows}) != len(windows):
            raise ValueError("재사용한 시작점을 두 번 실행·집계했습니다")
        for threshold in (.25, .30, .35):
            options_path = config / f"earlier-{round(threshold * 100)}-options.json"
            sources.add(options_path)
            options = json.loads(options_path.read_text())
            frozen = next(row for row in audit["conditions"] if row["threshold"] == threshold)
            if options["starts"] != frozen["starts"]:
                raise ValueError("성과 평가 전 고정한 시작일과 실행 옵션이 다릅니다")
            subset = [w for w in windows if w["startState"]["kospiVol20"] >= threshold]
            if [w["start"] for w in subset] != options["starts"]:
                raise ValueError("조건별 고정 날짜와 합친 계좌가 다릅니다")
            records.append({"candidate": candidate, "threshold": threshold, "all": summarize(subset), "nonoverlapping": summarize(nonoverlapping(subset)),
                            "affectedAccountCount": sum(bool(w["affectedActions"]) for w in subset),
                            "windows": [{k: w[k] for k in compact_fields} for w in subset],
                            "nonoverlappingStarts": [w["start"] for w in nonoverlapping(subset)]})
    (destination / "conditions.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    flat = [{"candidate": r["candidate"], "threshold": r["threshold"], **r["all"], "affectedAccountCount": r["affectedAccountCount"],
             **{f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()}} for r in records]
    with (destination / "conditions.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(flat)
    nonoverlap = [{k: v for k, v in r.items() if k != "windows"} | {"windows": [w for w in r["windows"] if w["start"] in r["nonoverlappingStarts"]]} for r in records]
    (destination / "nonoverlapping-accounts.json").write_text(json.dumps(nonoverlap, ensure_ascii=False, indent=2) + "\n")
    sources.update(root / "earlier" / name for name in ("krx-sample.jsonl.gz", "krx-daily.jsonl.gz", "krx-basic.jsonl.gz", "fred-api.jsonl.gz", "date-audit.json", "input-diagnostics.json", "fetch-failures.json"))
    sources.update(root / "sources-20260908" / name for name in ("index-KOSPI.json", "index-KOSDAQ.json", "vix.csv", "bok.html"))
    code = list(Path(__file__).parent.glob("*.ts")) + list(Path(__file__).parent.glob("*earlier*.py"))
    code += [Path(__file__).with_name("analyze_context.py"), Path(__file__).with_name("prepare_entry_dates.py"), Path(__file__).with_name("prepare_inputs.py"), Path("pnpm-lock.yaml")]
    code += list(Path("src/server/modules/backtest/domain").glob("*.ts")) + list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "413a89a", "newCandidateStageRuns": 6, "completedAccounts": sum(len(v) for v in grouped.values()),
                "files": files, "sourceSha256": {str(p): digest(p) for p in sorted(sources)}, "codeSha256": {str(p): digest(p) for p in sorted(set(code))}}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    compact = {k: v for k, v in manifest.items() if k != "files"}
    compact["manifestSha256"] = digest(destination / "manifest.json")
    compact["resultSetSha256"] = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    (destination / "evidence-manifest.json").write_text(json.dumps(compact, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"completedAccounts": manifest["completedAccounts"], "conditionSummaries": len(records)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
