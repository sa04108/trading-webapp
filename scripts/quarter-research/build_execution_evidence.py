"""체결 시드·순위 선정 일정의 고정 비교와 최초 매수 시각을 검증한다."""

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from analyze_context import nonoverlapping, summarize
from build_account_stop_evidence import digest, verify


def passes(row):
    return row["all"]["targetFrequencyPct"] > 50 and row["all"]["medianPct"] >= 10 and row["nonoverlapping"]["targetFrequencyPct"] > 50


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    cfg = Path(__file__).parent / "configs"
    experiments_path = cfg / "execution-stability-experiments.json"
    candidate_path = cfg / "account-stop-candidate.json"
    input_path = root / "expanded/stock-200-verified-input.json.gz"
    candidate = json.loads(candidate_path.read_text())[0]
    experiments = json.loads(experiments_path.read_text())
    expected = {(kind, value, stage) for kind, values in (("seed", (205, 206)), ("offset", (1, 2, 3, 4))) for value in values for stage in ("validation", "confirmation")}
    if len(experiments) != 12 or {(e["kind"], e["value"], e["stage"]) for e in experiments} != expected:
        raise ValueError("고정 실험 조합의 누락·중복")
    sources, files, records, baseline = {experiments_path, candidate_path, input_path}, [], [], {}
    for stage in ("validation", "confirmation"):
        options_path = cfg / f"account-stop-15-{stage}-options.json"
        options = json.loads(options_path.read_text())
        directory = f"account-stop/stop15-{stage}"
        windows, checked = verify(root, directory, candidate, stage, options_path, input_path, 15, options["starts"])
        files.extend(checked)
        sources.add(options_path)
        baseline[stage] = {w["start"]: json.loads((root / directory / f'{candidate["id"]}__{w["start"]}.json').read_text()) for w in windows}
        records.append({"kind": "baseline", "value": 0, "stage": stage, "seed": 204, "rebalanceOffsetBars": 0, "reused": True,
                        "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows})
    for e in experiments:
        base_options = json.loads((cfg / f'account-stop-15-{e["stage"]}-options.json').read_text())
        options_path = cfg / e["options"]
        options = json.loads(options_path.read_text())
        offset, seed = (e["value"], 204) if e["kind"] == "offset" else (0, e["value"])
        expected_options = base_options | ({"rebalanceOffsetBars": offset} if offset else {})
        if (e["input"] != str(input_path.relative_to(root)) or e["selection"] != candidate_path.name or e["slippageBps"] != 5
                or e["seed"] != seed or e["rebalanceOffsetBars"] != offset or options != expected_options):
            raise ValueError("시드·일정 이외의 고정 설정이 달라졌습니다")
        windows, checked = verify(root, e["directory"], candidate, e["stage"], options_path, input_path, 15, options["starts"], seed=seed)
        files.extend(checked)
        sources.add(options_path)
        audits, pairs = [], []
        for w in windows:
            base = baseline[e["stage"]][w["start"]]
            run = json.loads((root / e["directory"] / f'{candidate["id"]}__{w["start"]}.json').read_text())
            days = [p["tsMs"] for p in base["result"]["equityPoints"]]
            if [p["tsMs"] for p in run["result"]["equityPoints"]] != days or run["risk"] != base["risk"] or w["startState"] != base["summary"]["startState"]:
                raise ValueError("일정 이동이 시작 조건·만기·평가 시간축을 바꿨습니다")
            buys = [f for f in run["result"]["fills"] if f["side"] == "BUY"]
            first_buy = min((f["tsMs"] for f in buys), default=None)
            if first_buy is not None and first_buy < days[offset + 2]:
                raise ValueError("최초 순위 선정·다음 매수 신호 전에 체결이 생겼습니다")
            if any(f["tsMs"] > days[-1] for f in run["result"]["fills"]):
                raise ValueError("원래 계좌 만기 이후의 체결")
            date = lambda ts: datetime.fromtimestamp(ts / 1000, timezone.utc).strftime("%Y-%m-%d") if ts is not None else None
            audits.append({"start": w["start"], "firstRanking": date(days[offset]), "earliestPossibleBuy": date(days[offset + 2]),
                           "firstBuy": date(first_buy), "lastValuation": date(days[-1]), "end": w["end"]})
            pairs.append({"start": w["start"], "baseReturnPct": base["summary"]["returnPct"], "returnPct": w["returnPct"],
                          "returnDeltaPctPoints": w["returnPct"] - base["summary"]["returnPct"],
                          "baseTargetReached": base["summary"]["targetReached"], "targetReached": w["targetReached"]})
        records.append({k: e[k] for k in ("kind", "value", "stage", "seed", "rebalanceOffsetBars")} | {
            "reused": False, "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows,
            "scheduleAudit": audits, "paired": pairs})
    for r in records:
        r["passes"] = passes(r)
    (destination / "all-results.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    flat = [{k: r[k] for k in ("kind", "value", "stage", "seed", "rebalanceOffsetBars", "reused", "passes")} | r["all"]
            | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in records]
    with (destination / "all-summaries.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(flat)
    fields = ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "riskEvents", "affectedActions")
    compact = [{k: v for k, v in r.items() if k not in ("windows", "paired", "scheduleAudit")} | {
        "windows": [{k: w[k] for k in fields} for w in nonoverlapping(r["windows"])]} for r in records]
    (destination / "nonoverlapping-accounts.json").write_text(json.dumps(compact, ensure_ascii=False, indent=2) + "\n")
    for key in ("paired", "scheduleAudit"):
        compact = [{k: r[k] for k in ("kind", "value", "stage", key)} for r in records if not r["reused"]]
        (destination / f"{key}.json").write_text(json.dumps(compact, ensure_ascii=False, indent=2) + "\n")
    code = [Path(__file__), Path(__file__).with_name("build_account_stop_evidence.py"), Path(__file__).with_name("analyze_context.py"),
            Path(__file__).with_name("prepare_entry_dates.py"), Path("pnpm-lock.yaml"), Path("tests/unit/quarter-research.test.ts")]
    code += list(Path(__file__).parent.glob("*.ts")) + list(Path("src/server/modules/backtest/domain").glob("*.ts")) + list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "445aea9", "newExperiments": len(experiments),
                "newAccounts": sum(r["all"]["count"] for r in records if not r["reused"]), "reusedAccounts": sum(r["all"]["count"] for r in records if r["reused"]),
                "allSettingsPassed": all(r["passes"] for r in records), "files": files,
                "sourceSha256": {str(p): digest(p) for p in sorted(sources)}, "codeSha256": {str(p): digest(p) for p in sorted(set(code))}}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    evidence = {k: v for k, v in manifest.items() if k != "files"} | {"manifestSha256": digest(destination / "manifest.json"),
        "resultSetSha256": hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}
    (destination / "evidence-manifest.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: manifest[k] for k in ("newExperiments", "newAccounts", "reusedAccounts", "allSettingsPassed")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
