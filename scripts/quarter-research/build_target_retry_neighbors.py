"""고정한 단일 변수 이웃을 기본 재개 계좌와 같은 날짜에서 대조한다."""

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from analyze_context import nonoverlapping, summarize
from build_account_stop_evidence import digest, verify
from build_execution_evidence import passes
from build_target_retry_evidence import audit


def trade_path(path):
    """실제 체결을 날짜·방향·이유로 묶어 교체 시점의 차이를 보존한다."""
    run = json.loads(path.read_text())
    groups = {}
    for fill in run["result"]["fills"]:
        date = datetime.fromtimestamp(fill["tsMs"] / 1000, timezone.utc).strftime("%Y-%m-%d")
        key = (date, fill["side"], fill["reason"])
        groups.setdefault(key, []).append({k: fill[k] for k in ("symbol", "quantity", "price")})
    return {"file": str(path), "sha256": digest(path), "riskEvents": run["summary"]["riskEvents"],
            "totalCostsKrw": sum(run["result"]["metrics"][k] for k in ("totalCommission", "totalTax", "totalSlippage")),
            "fillGroups": [{"date": d, "side": side, "reason": reason, "fills": fills} for (d, side, reason), fills in groups.items()]}


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    cfg = Path(__file__).parent / "configs"
    experiments_path, base_path = cfg / "target-retry-neighbors-experiments.json", cfg / "account-stop-candidate.json"
    protocol = Path("docs/research/kr-current-quarter-target-retry-neighbors-protocol.md")
    input_path = root / "expanded/stock-200-verified-input.json.gz"
    base_candidate = json.loads(base_path.read_text())[0]
    experiments = json.loads(experiments_path.read_text())
    variants = {"formation21": ({"formationDays": 21}, 5, 20), "formation25": ({"formationDays": 25}, 5, 20),
                "top4": ({"topN": 4}, 4, 20), "top6": ({"topN": 6}, 6, 20), "rebalance15": ({}, 5, 15), "rebalance25": ({}, 5, 25)}
    if len(experiments) != 12 or {(e["variant"], e["stage"]) for e in experiments} != {(v, s) for v in variants for s in ("validation", "confirmation")}:
        raise ValueError("사전에 고정한 이웃 후보·단계의 누락·중복")
    sources, files, records, baseline = {experiments_path, base_path, protocol, input_path}, [], [], {}
    version = "2.2.1+history-reset.1+target-retry.1"
    for stage in ("validation", "confirmation"):
        options_path = cfg / f"target-retry-seed204-offset0-{stage}-options.json"
        options = json.loads(options_path.read_text())
        directory = f"target-retry/seed204-offset0-{stage}"
        windows, checked = verify(root, directory, base_candidate, stage, options_path, input_path, 15, options["starts"], strategy_version=version)
        files.extend(checked)
        sources.add(options_path)
        baseline[stage] = {w["start"]: json.loads((root / directory / f'{base_candidate["id"]}__{w["start"]}.json').read_text()) for w in windows}
        records.append({"variant": "baseline", "stage": stage, "candidate": base_candidate, "reused": True,
                        "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows})
    for e in experiments:
        modified_parameters, top_n, rebalance = variants[e["variant"]]
        expected = base_candidate | {"id": "target-retry-neighbor-" + e["variant"], "parameters": base_candidate["parameters"] | modified_parameters,
                                     "topN": top_n, "rebalanceBars": rebalance}
        candidate_path = cfg / e["selection"]
        candidates = json.loads(candidate_path.read_text())
        if (candidates != [expected] or e["options"] != f'target-retry-seed204-offset0-{e["stage"]}-options.json'
                or e["input"] != str(input_path.relative_to(root)) or e["seed"] != 204 or e["slippageBps"] != 5):
            raise ValueError("고정한 단일 변수 이외의 후보·실행 설정이 바뀌었습니다")
        options_path = cfg / e["options"]
        options = json.loads(options_path.read_text())
        parameters = expected["parameters"] | {"absoluteMomentumFilter": True}
        windows, checked = verify(root, e["directory"], expected, e["stage"], options_path, input_path, 15, options["starts"],
                                  strategy_version=version, expected_parameters=parameters)
        files.extend(checked)
        sources.add(candidate_path)
        pairs = []
        for w in windows:
            run = json.loads((root / e["directory"] / f'{expected["id"]}__{w["start"]}.json').read_text())
            base = baseline[e["stage"]][w["start"]]
            pair = audit(run, base, same_strategy=False)
            if run["result"]["metrics"]["maxConcurrentPositions"] > top_n:
                raise ValueError("후보의 고정 보유 수를 초과했습니다")
            if any(f["side"] == "BUY" and f["tsMs"] < base["result"]["equityPoints"][2]["tsMs"] for f in run["result"]["fills"]):
                raise ValueError("최초 순위 선정·매수 판단 전에 체결했습니다")
            pairs.append(pair)
        record = {"variant": e["variant"], "stage": e["stage"], "candidate": expected, "reused": False,
                  "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows, "paired": pairs,
                  "failureToSuccess": sum(not p["baseTargetReached"] and p["targetReached"] for p in pairs),
                  "successToFailure": sum(p["baseTargetReached"] and not p["targetReached"] for p in pairs),
                  "returnImproved": sum(p["returnDeltaPctPoints"] > 1e-8 for p in pairs), "returnWorsened": sum(p["returnDeltaPctPoints"] < -1e-8 for p in pairs)}
        records.append(record)
    for r in records:
        r["passes"] = passes(r)
    write = lambda name, value: (destination / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    write("all-results.json", records)
    flat = [{k: r[k] for k in ("variant", "stage", "reused", "passes")} | {"formationDays": r["candidate"]["parameters"]["formationDays"],
             "topN": r["candidate"]["topN"], "rebalanceBars": r["candidate"]["rebalanceBars"]} | r["all"]
            | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in records]
    with (destination / "all-summaries.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(flat)
    fields = ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "riskEvents", "affectedActions")
    write("nonoverlapping-accounts.json", [{k: v for k, v in r.items() if k not in ("windows", "paired")} | {
        "windows": [{k: w[k] for k in fields} for w in nonoverlapping(r["windows"])]} for r in records])
    write("paired-accounts.json", [{k: r[k] for k in ("variant", "stage", "paired")} for r in records if not r["reused"]])
    affected, failed = [], []
    for r in records:
        if r["reused"]:
            continue
        experiment = next(e for e in experiments if e["variant"] == r["variant"] and e["stage"] == r["stage"])
        for w in r["windows"]:
            if w["affectedActions"]:
                path = root / experiment["directory"] / f'{r["candidate"]["id"]}__{w["start"]}.json'
                affected.append({"variant": r["variant"], "stage": r["stage"], "file": str(path), "sha256": digest(path)}
                                | {k: w[k] for k in fields})
        if r["passes"]:
            continue
        accounts = []
        for w in nonoverlapping(r["windows"]):
            path = root / experiment["directory"] / f'{r["candidate"]["id"]}__{w["start"]}.json'
            base_run_path = root / f'target-retry/seed204-offset0-{r["stage"]}' / f'{base_candidate["id"]}__{w["start"]}.json'
            run, base = json.loads(path.read_text()), baseline[r["stage"]][w["start"]]
            different = next((p["tsMs"] for p, q in zip(run["result"]["equityPoints"], base["result"]["equityPoints"])
                              if p != q), None)
            accounts.append(next(p for p in r["paired"] if p["start"] == w["start"]) | {
                "firstDifferentEquityDate": datetime.fromtimestamp(different / 1000, timezone.utc).strftime("%Y-%m-%d") if different else None,
                "base": trade_path(base_run_path), "neighbor": trade_path(path)})
        failed.append({k: r[k] for k in ("variant", "stage", "passes", "all", "nonoverlapping")} | {"accounts": accounts})
    write("affected-action-accounts.json", affected)
    write("failed-setting-audit.json", failed)
    code = [Path(__file__), Path(__file__).with_name("build_target_retry_evidence.py"), Path(__file__).with_name("build_account_stop_evidence.py"),
            Path(__file__).with_name("build_execution_evidence.py"), Path(__file__).with_name("analyze_context.py"),
            Path(__file__).with_name("prepare_entry_dates.py"), Path("pnpm-lock.yaml"), Path("tests/unit/target-retry-quarter.test.ts"), Path("tests/unit/quarter-research.test.ts")]
    code += list(Path(__file__).parent.glob("*.ts")) + list(Path("src/server/modules/backtest/domain").glob("*.ts")) + list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "c6d7e78", "newExperiments": 12,
                "newAccounts": sum(r["all"]["count"] for r in records if not r["reused"]), "reusedAccounts": sum(r["all"]["count"] for r in records if r["reused"]),
                "allNeighborSettingsPassed": all(r["passes"] for r in records if not r["reused"]), "files": files,
                "sourceSha256": {str(p): digest(p) for p in sorted(sources)}, "codeSha256": {str(p): digest(p) for p in sorted(set(code))}}
    write("manifest.json", manifest)
    write("evidence-manifest.json", {k: v for k, v in manifest.items() if k != "files"} | {"manifestSha256": digest(destination / "manifest.json"),
        "resultSetSha256": hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()})
    print(json.dumps({k: manifest[k] for k in ("newExperiments", "newAccounts", "reusedAccounts", "allNeighborSettingsPassed")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
