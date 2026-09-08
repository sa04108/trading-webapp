"""후속 탐색을 이전 결과와 분리해 집계하고 자료 충족 구간·환경 진단을 보존한다."""

import argparse
import csv
import hashlib
import json
from pathlib import Path

from analyze_context import analyze, nonoverlapping, summarize


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    config = Path(__file__).parent / "configs"
    experiments = json.loads((config / "followup-experiments.json").read_text())
    coverage = json.loads((root / "followup/quarterly-coverage.json").read_text())
    covered = {stage["stage"]: {w["start"] for w in stage["windows"] if w["fraction"] >= .5} for stage in coverage["stages"]}
    records, files = [], []
    for experiment in experiments:
        expected_input = digest(root / experiment["input"])
        for candidate in json.loads((config / experiment["selection"]).read_text()):
            source = root / experiment["directory"] / f'{candidate["id"]}__summary.json'
            trial = json.loads(source.read_text())
            if trial["candidate"] != candidate or trial["stage"] != experiment["stage"]:
                raise ValueError(f"설정과 결과 불일치: {source}")
            if trial["inputSha256"] != expected_input:
                raise ValueError(f"원래 입력 해시와 결과 불일치: {source}")
            if len(trial["windows"]) != trial["all"]["count"]:
                raise ValueError(f"요약과 계좌 수 불일치: {source}")
            for window in trial["windows"]:
                run = source.parent / f'{candidate["id"]}__{window["start"]}.json'
                full = json.loads(run.read_text())
                if (full.get("status") == "failed" or full["summary"] != window or full["candidate"] != candidate
                        or full["inputSha256"] != expected_input or full["stage"] != experiment["stage"]):
                    raise ValueError(f"실패 또는 요약 불일치: {run}")
                files.append({"file": str(run.relative_to(root)), "sha256": digest(run)})
            files.append({"file": str(source.relative_to(root)), "sha256": digest(source)})
            ready = [w for w in trial["windows"] if w["start"] in covered[trial["stage"]]]
            records.append({"directory": experiment["directory"], "candidate": candidate, "stage": trial["stage"],
                            "inputSha256": trial["inputSha256"], "uncertainActionAccounts": sum(bool(w["affectedActions"]) for w in trial["windows"]), "all": trial["all"], "nonoverlapping": trial["nonoverlapping"],
                            "majorityQuarterData": summarize(ready), "majorityQuarterDataNonoverlapping": summarize(nonoverlapping(ready)),
                            "windows": trial["windows"]})
    (destination / "all-summaries.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    flat = [{"directory": r["directory"], "candidate": r["candidate"]["id"], "stage": r["stage"], "uncertainActionAccounts": r["uncertainActionAccounts"], **r["all"],
             **{f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()},
             **{f"majorityData_{k}": v for k, v in r["majorityQuarterData"].items()}} for r in records]
    with (destination / "all-summaries.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(flat[0]))
        writer.writeheader()
        writer.writerows(flat)
    analyze(root, [e["directory"] for e in experiments], destination / "context-analysis.json")
    contexts = json.loads((destination / "context-analysis.json").read_text())["records"]
    context_rows = [{"directory": r["directory"], "candidate": r["candidate"]["id"], "condition": r["condition"],
                     **r["all"], **{f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()}} for r in contexts]
    with (destination / "context-summary.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(context_rows[0]))
        writer.writeheader()
        writer.writerows(context_rows)
    sources = [root / e["input"] for e in experiments]
    sources += [root / "followup" / name for name in ("dart-quarterly.jsonl.gz", "dart-request-codes.json", "quarterly-observations.json",
                                                    "quarterly-coverage.json", "quarterly-current-input.json.gz", "earnings-current-signals.json")]
    code = list(Path(__file__).parent.rglob("*"))
    code += list(Path("src/server/modules/backtest/domain").glob("*.ts"))
    code += list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    code += list(Path("src/server/modules/facts/domain").glob("*.ts"))
    code += list(Path("tests/unit").glob("*quarter*.test.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "b3e80bf", "summaryCount": len(records),
                "developmentConfigurations": sum(r["stage"] == "development" for r in records),
                "completedQuarterAccounts": sum(r["all"]["count"] for r in records), "files": files,
                "sourceSha256": {str(p): digest(p) for p in sorted(set(sources))},
                "codeSha256": {str(p): digest(p) for p in sorted(set(code)) if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"},
                "note": "이전 b3e80bf 탐색과 별도 보존한다. 중첩 계좌와 자료 부족 기간을 독립 검증 표본으로 해석하지 않는다."}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    compact = {k: v for k, v in manifest.items() if k != "files"}
    compact["resultManifestSha256"] = digest(destination / "manifest.json")
    compact["resultSetSha256"] = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    (destination / "evidence-manifest.json").write_text(json.dumps(compact, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: manifest[k] for k in ("summaryCount", "developmentConfigurations", "completedQuarterAccounts")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
