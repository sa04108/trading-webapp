"""고정 재개 정책의 비용·조건 문턱·과거 부진을 같은 계좌와 대조한다."""

import argparse
import csv
import hashlib
import json
from pathlib import Path

from analyze_context import nonoverlapping, summarize
from build_account_stop_evidence import digest, verify
from build_execution_evidence import passes
from build_target_retry_evidence import audit


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    cfg = Path(__file__).parent / "configs"
    experiments_path = cfg / "target-retry-diagnostics-experiments.json"
    original_experiments = cfg / "account-stop-diagnostics-experiments.json"
    conditions_path, candidate_path = cfg / "account-stop-condition-dates.json", cfg / "account-stop-candidate.json"
    protocol = Path("docs/research/kr-current-quarter-target-retry-diagnostics-protocol.md")
    candidate = json.loads(candidate_path.read_text())[0]
    experiments = json.loads(experiments_path.read_text())
    expected = [e for e in json.loads(original_experiments.read_text()) if e["accountStopPct"] == 15]
    if len(experiments) != 8:
        raise ValueError("고정한 후속 실행의 누락·중복")
    for e, base in zip(experiments, expected, strict=True):
        if (e != base | {"directory": e["directory"], "options": e["options"], "baseline": base["directory"], "baselineOptions": base["options"]}
                or e["directory"] != "target-retry-diagnostics/" + base["directory"].split("/")[-1]):
            raise ValueError("이전 고정 진단에서 재개 이외의 실행 설정이 바뀌었습니다")
    for stage in ("validation", "confirmation"):
        experiments.append({"directory": f"target-retry/seed204-offset0-{stage}", "baseline": f"account-stop/stop15-{stage}",
                            "options": f"target-retry-seed204-offset0-{stage}-options.json", "baselineOptions": f"account-stop-15-{stage}-options.json",
                            "stage": stage, "input": "expanded/stock-200-verified-input.json.gz", "selection": candidate_path.name,
                            "slippageBps": 5, "seed": 204, "accountStopPct": 15, "diagnostic": "primary", "reused": True})
    sources = {experiments_path, original_experiments, conditions_path, candidate_path, protocol}
    files, records = [], []
    for e in experiments:
        options_path, baseline_options, input_path = cfg / e["options"], cfg / e["baselineOptions"], root / e["input"]
        options, original = json.loads(options_path.read_text()), json.loads(baseline_options.read_text())
        if options != original | {"resumeAfterMissedTarget": True} or e["seed"] != 204 or e["accountStopPct"] != 15:
            raise ValueError("고정한 재개·위험·시드 설정이 다릅니다")
        sources.update((options_path, baseline_options, input_path))
        base_windows, checked = verify(root, e["baseline"], candidate, e["stage"], baseline_options, input_path, 15, original["starts"], e["slippageBps"])
        files.extend(checked)
        windows, checked = verify(root, e["directory"], candidate, e["stage"], options_path, input_path, 15, options["starts"], e["slippageBps"],
                                  strategy_version="2.2.1+history-reset.1+target-retry.1")
        files.extend(checked)
        pairs = []
        for w in windows:
            filename = f'{candidate["id"]}__{w["start"]}.json'
            pairs.append(audit(json.loads((root / e["directory"] / filename).read_text()), json.loads((root / e["baseline"] / filename).read_text())))
        record = {k: e[k] for k in ("directory", "baseline", "stage", "slippageBps", "diagnostic")}
        record.update({"reused": e.get("reused", False), "baseAll": summarize(base_windows), "baseNonoverlapping": summarize(nonoverlapping(base_windows)),
                       "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows, "baseWindows": base_windows, "paired": pairs,
                       "resumedAccounts": sum(bool(p["resumptions"]) for p in pairs), "resumptions": sum(len(p["resumptions"]) for p in pairs),
                       "failureToSuccess": sum(not p["baseTargetReached"] and p["targetReached"] for p in pairs),
                       "successToFailure": sum(p["baseTargetReached"] and not p["targetReached"] for p in pairs),
                       "returnWorsened": sum(p["returnDeltaPctPoints"] < -1e-8 for p in pairs),
                       "extraFills": sum(p["extraFills"] for p in pairs), "extraCostsKrw": sum(p["extraCostsKrw"] for p in pairs)})
        record["passes"] = passes(record)
        records.append(record)
    conditions = json.loads(conditions_path.read_text())
    condition_records = []
    for stage in ("validation", "confirmation", "earlier"):
        relevant = [r for r in records if r["stage"] == stage and r["diagnostic"] in ("primary", "extra25", "earlier")]
        windows = sorted([w for r in relevant for w in r["windows"]], key=lambda w: w["start"])
        baseline = sorted([w for r in relevant for w in r["baseWindows"]], key=lambda w: w["start"])
        for threshold in (.25, .30, .35):
            if stage == "earlier":
                path = cfg / f"earlier-{int(threshold * 100)}-options.json"
                sources.add(path)
                starts = json.loads(path.read_text())["starts"]
            else:
                starts = conditions[stage][str(threshold)]
            subset = [w for w in windows if w["startState"]["kospiVol20"] >= threshold]
            base_subset = [w for w in baseline if w["startState"]["kospiVol20"] >= threshold]
            if [w["start"] for w in subset] != starts or [w["start"] for w in base_subset] != starts:
                raise ValueError("조건별 고정 시작일의 중복·누락")
            row = {"stage": stage, "threshold": threshold, "baseAll": summarize(base_subset), "baseNonoverlapping": summarize(nonoverlapping(base_subset)),
                   "all": summarize(subset), "nonoverlapping": summarize(nonoverlapping(subset)), "windows": subset}
            row["passes"] = bool(subset) and passes(row)
            condition_records.append(row)
    write = lambda name, value: (destination / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    write("all-diagnostics.json", records)
    write("conditions.json", condition_records)
    for name, rows, keys in (("all-diagnostics.csv", records, ("stage", "slippageBps", "diagnostic", "reused", "passes", "resumedAccounts", "resumptions", "failureToSuccess", "successToFailure", "returnWorsened", "extraFills", "extraCostsKrw")),
                             ("conditions.csv", condition_records, ("stage", "threshold", "passes"))):
        flat = [{k: r[k] for k in keys} | r["all"] | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in rows]
        with (destination / name).open("w") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
            writer.writeheader()
            writer.writerows(flat)
    fields = ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "riskEvents", "affectedActions")
    write("nonoverlapping-diagnostics.json", [{k: v for k, v in r.items() if k not in ("windows", "baseWindows", "paired")} | {
        "windows": [{k: w[k] for k in fields} for w in nonoverlapping(r["windows"])]} for r in records + condition_records])
    write("paired-accounts.json", [{k: r[k] for k in ("stage", "slippageBps", "diagnostic", "reused", "paired")} for r in records])
    code = [Path(__file__), Path(__file__).with_name("build_target_retry_evidence.py"), Path(__file__).with_name("build_account_stop_evidence.py"),
            Path(__file__).with_name("build_execution_evidence.py"), Path(__file__).with_name("analyze_context.py"),
            Path(__file__).with_name("prepare_entry_dates.py"), Path("pnpm-lock.yaml"), Path("tests/unit/target-retry-quarter.test.ts"), Path("tests/unit/quarter-research.test.ts")]
    code += list(Path(__file__).parent.glob("*.ts")) + list(Path("src/server/modules/backtest/domain").glob("*.ts")) + list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "bb6af78", "newExperiments": 8,
                "newAccounts": sum(r["all"]["count"] for r in records if not r["reused"]),
                "reusedRetryAccounts": sum(r["all"]["count"] for r in records if r["reused"]), "baselineAccounts": sum(r["baseAll"]["count"] for r in records),
                "costAndCurrentStageThresholdsPassed": all(r["passes"] for r in records if r["diagnostic"] == "cost")
                and all(r["passes"] for r in condition_records if r["stage"] != "earlier"),
                "developmentAndEarlierPassed": all(r["passes"] for r in records if r["diagnostic"] in ("development", "earlier")),
                "files": files, "sourceSha256": {str(p): digest(p) for p in sorted(sources)}, "codeSha256": {str(p): digest(p) for p in sorted(set(code))}}
    write("manifest.json", manifest)
    write("evidence-manifest.json", {k: v for k, v in manifest.items() if k != "files"} | {"manifestSha256": digest(destination / "manifest.json"),
        "resultSetSha256": hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()})
    print(json.dumps({k: manifest[k] for k in ("newExperiments", "newAccounts", "reusedRetryAccounts", "baselineAccounts", "costAndCurrentStageThresholdsPassed", "developmentAndEarlierPassed")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
