"""가치평가·종목군 확대 탐색과 현재 신호 정정을 이전 증거와 분리해 보존한다."""

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
    experiments = json.loads((config / "value-experiments.json").read_text())
    coverage = json.loads((root / "value/valuation-coverage.json").read_text())
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
                if (full["slippageBps"] != experiment["slippageBps"] or full["seed"] != experiment["seed"]
                        or full["risk"]["initialCash"] != 100_000_000 or full["risk"]["targetPct"] != 10.5 or full["risk"]["stopPct"] != 10):
                    raise ValueError(f"고정한 비용·시드·계좌 규칙과 결과 불일치: {run}")
                files.append({"file": str(run.relative_to(root)), "sha256": digest(run)})
            files.append({"file": str(source.relative_to(root)), "sha256": digest(source)})
            ready = [w for w in trial["windows"] if w["start"] in covered[trial["stage"]]] if candidate["strategyId"] == "low-per-quarterly-research" else []
            records.append({"directory": experiment["directory"], "slippageBps": experiment["slippageBps"], "seed": experiment["seed"], "candidate": candidate, "stage": trial["stage"],
                            "inputSha256": trial["inputSha256"], "uncertainActionAccounts": sum(bool(w["affectedActions"]) for w in trial["windows"]), "all": trial["all"], "nonoverlapping": trial["nonoverlapping"],
                            "majorityValuationData": summarize(ready), "majorityValuationDataNonoverlapping": summarize(nonoverlapping(ready)),
                            "windows": trial["windows"]})
    (destination / "all-summaries.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    flat = [{"directory": r["directory"], "slippageBps": r["slippageBps"], "seed": r["seed"], "candidate": r["candidate"]["id"], "stage": r["stage"], "uncertainActionAccounts": r["uncertainActionAccounts"], **r["all"],
             **{f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()},
             **{f"majorityData_{k}": v for k, v in r["majorityValuationData"].items()}} for r in records]
    with (destination / "all-summaries.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(dict.fromkeys(k for r in flat for k in r)))
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
    sources += [root / name for name in (
        "followup/dart-quarterly.jsonl.gz", "followup/dart-request-codes.json",
        "value/valuation-observations.json", "value/valuation-coverage.json", "value/complete-current-input.json.gz",
        "value/current-signals.json", "value/current-signal-correction.json", "value/calendar-audit.json",
        "value/current-history-repair/manifest.json", "expanded/current-liquid-manifest.json",
        "expanded/current-provisional/manifest.json", "expanded/current-stock-input.json.gz", "expanded/current-signals.json",
        "expanded/current-krx.jsonl.gz", "expanded/current-krx-kosdaq.jsonl.gz",
        "expanded/sources/kai-2017q3-investor-protection.html")]
    volatility_records = []
    for trial in records:
        if trial["directory"].startswith("expanded/"):
            for threshold in (.25, .30, .35):
                rows = [r for r in trial["windows"] if r["startState"]["kospiVol20"] >= threshold
                        and r["startState"]["kospiRet20"] > 0
                        and r["startState"]["kospi"] > r["startState"]["kospiSma20"]]
                volatility_records.append({"directory": trial["directory"], "candidate": trial["candidate"]["id"],
                                           "threshold": threshold, "all": summarize(rows),
                                           "nonoverlapping": summarize(nonoverlapping(rows)), "windows": rows})
    (destination / "volatility-context.json").write_text(json.dumps({
        "note": "전체 성과를 본 뒤 추가한 가설이다. 조건 수익을 보기 전 25·30·35% 문턱을 고정했으며 독립 검증으로 해석하지 않는다.",
        "records": volatility_records}, ensure_ascii=False, indent=2) + "\n")
    code = list(Path(__file__).parent.rglob("*"))
    code += list(Path("src/server/modules/backtest/domain").glob("*.ts"))
    code += list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    code += list(Path("src/server/modules/facts/domain").glob("*.ts"))
    code += list(Path("tests/unit").glob("*quarter*.test.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "8a8ccaf", "summaryCount": len(records),
                "developmentConfigurations": sum(r["stage"] == "development" for r in records),
                "completedQuarterAccounts": sum(r["all"]["count"] for r in records), "files": files,
                "sourceSha256": {str(p): digest(p) for p in sorted(set(sources))},
                "codeSha256": {str(p): digest(p) for p in sorted(set(code)) if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"},
                "note": "이전 8a8ccaf까지의 탐색과 별도 보존한다. 중첩 계좌와 자료 부족 기간을 독립 검증 표본으로 해석하지 않는다."}
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
