"""계좌 중단 비교의 후속 구간·비용·조건 문턱을 누락 없이 집계한다."""

import argparse
import csv
import hashlib
import json
from pathlib import Path

from analyze_context import nonoverlapping, summarize
from build_account_stop_evidence import digest, verify


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    cfg = Path(__file__).parent / "configs"
    experiments_path = cfg / "account-stop-diagnostics-experiments.json"
    conditions_path = cfg / "account-stop-condition-dates.json"
    candidate_path = cfg / "account-stop-candidate.json"
    candidate = json.loads(candidate_path.read_text())[0]
    experiments = json.loads(experiments_path.read_text())
    conditions = json.loads(conditions_path.read_text())
    primary_path = root / "account-stop/evidence/all-results.json"
    primary = json.loads(primary_path.read_text())
    eligible = [stop for stop in (15, 20) if all(next(r for r in primary if r["accountStopPct"] == stop and r["stage"] == stage)["all"]["targetFrequencyPct"] > 50
                and next(r for r in primary if r["accountStopPct"] == stop and r["stage"] == stage)["all"]["medianPct"] >= 10
                and next(r for r in primary if r["accountStopPct"] == stop and r["stage"] == stage)["nonoverlapping"]["targetFrequencyPct"] > 50
                for stage in ("validation", "confirmation"))]
    if eligible != [15, 20]:
        raise ValueError("추가 평가를 진행하는 기본 문턱과 후보가 다릅니다")
    sources = {experiments_path, conditions_path, candidate_path, primary_path}
    records, files = [], []
    for e in experiments:
        options_path, input_path = cfg / e["options"], root / e["input"]
        options = json.loads(options_path.read_text())
        if options["accountStopPct"] != e["accountStopPct"] or options["resetUncertainHistory"] is not True or e["seed"] != 204 or e["selection"] != candidate_path.name:
            raise ValueError("고정 후속 실험의 설정 불일치")
        windows, checked = verify(root, e["directory"], candidate, e["stage"], options_path, input_path, e["accountStopPct"], options["starts"], e["slippageBps"])
        files.extend(checked)
        sources.update((options_path, input_path))
        records.append({k: e[k] for k in ("directory", "stage", "accountStopPct", "slippageBps", "diagnostic")} | {
            "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows})
    condition_records = []
    for stage in ("validation", "confirmation"):
        baseline_options = cfg / f"entry-{stage}-options.json"
        input_path = root / "expanded/stock-200-verified-input.json.gz"
        baseline, checked = verify(root, f"entry/daily-{stage}", candidate, stage, baseline_options, input_path, 10, conditions[stage]["0.25"])
        files.extend(checked)
        sources.add(baseline_options)
        for stop in (10, 15, 20):
            if stop == 10:
                windows = baseline
            else:
                windows = next(r["windows"] for r in primary if r["accountStopPct"] == stop and r["stage"] == stage)
                extra = next(r["windows"] for r in records if r["accountStopPct"] == stop and r["stage"] == stage and r["diagnostic"] == "extra25")
                windows = sorted(windows + extra, key=lambda w: w["start"])
            if [w["start"] for w in windows] != conditions[stage]["0.25"]:
                raise ValueError("기본 시작일과 추가 25% 날짜의 중복·누락")
            for threshold in (.25, .30, .35):
                subset = [w for w in windows if w["startState"]["kospiVol20"] >= threshold]
                if [w["start"] for w in subset] != conditions[stage][str(threshold)]:
                    raise ValueError("고정 조건 문턱의 날짜와 집계 불일치")
                condition_records.append({"stage": stage, "accountStopPct": stop, "threshold": threshold,
                                          "all": summarize(subset), "nonoverlapping": summarize(nonoverlapping(subset)), "windows": subset})
    (destination / "all-diagnostics.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    (destination / "conditions.json").write_text(json.dumps(condition_records, ensure_ascii=False, indent=2) + "\n")
    for name, rows, identifiers in (("all-diagnostics.csv", records, ("directory", "stage", "accountStopPct", "slippageBps", "diagnostic")),
                                    ("conditions.csv", condition_records, ("stage", "accountStopPct", "threshold"))):
        flat = [{k: r[k] for k in identifiers} | r["all"] | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in rows]
        with (destination / name).open("w") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
            writer.writeheader()
            writer.writerows(flat)
    fields = ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "riskEvents", "affectedActions")
    compact = [{k: v for k, v in r.items() if k != "windows"} | {"windows": [{k: w[k] for k in fields} for w in nonoverlapping(r["windows"])]} for r in records + condition_records]
    (destination / "nonoverlapping-diagnostics.json").write_text(json.dumps(compact, ensure_ascii=False, indent=2) + "\n")
    primary_manifest_path = root / "account-stop/evidence/manifest.json"
    primary_manifest = json.loads(primary_manifest_path.read_text())
    for row in primary_manifest["files"]:
        if digest(root / row["file"]) != row["sha256"]:
            raise ValueError("기본 비교에서 검증한 계좌 파일이 바뀌었습니다")
    files.extend(primary_manifest["files"])
    unique = {row["file"]: row["sha256"] for row in files}
    new_count = sum(r["all"]["count"] for r in records)
    sources.update((primary_manifest_path, Path(__file__), Path(__file__).with_name("build_account_stop_evidence.py")))
    manifest = {"asof": "2026-09-08", "baseCommit": "d5995a2", "additionalExperiments": len(experiments), "additionalAccounts": new_count,
                "totalNewAccounts": new_count + primary_manifest["newAccounts"], "reusedAccounts": sum(len(conditions[s]["0.25"]) for s in conditions),
                "eligibleAccountStops": eligible, "files": unique, "sourceSha256": {str(p): digest(p) for p in sorted(sources)}}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    evidence = {k: v for k, v in manifest.items() if k != "files"} | {"manifestSha256": digest(destination / "manifest.json"),
        "resultSetSha256": hashlib.sha256(json.dumps(unique, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}
    (destination / "evidence-manifest.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: manifest[k] for k in ("additionalExperiments", "additionalAccounts", "totalNewAccounts", "reusedAccounts")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
