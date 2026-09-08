"""계좌 중단 완화의 같은 날짜 성과·손실 변화를 원본 계좌와 대조한다."""

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

from analyze_context import nonoverlapping, summarize
from prepare_entry_dates import end_of_quarter


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(root, directory, candidate, stage, options_path, input_path, stop, starts, slippage=5, seed=204):
    options = json.loads(options_path.read_text())
    summary_path = root / directory / f'{candidate["id"]}__summary.json'
    summary = json.loads(summary_path.read_text())
    hashes = {"inputSha256": digest(input_path), "optionsSha256": digest(options_path)}
    if (summary["candidate"] != candidate or summary["options"] != options or summary["stage"] != stage
            or any(summary[k] != v for k, v in hashes.items())
            or [w["start"] for w in summary["windows"]] != options["starts"]):
        raise ValueError("계좌 요약의 후보·원문·옵션·시작일 불일치")
    windows = [w for w in summary["windows"] if w["start"] in starts]
    if [w["start"] for w in windows] != starts:
        raise ValueError("고정한 시작일의 계좌가 없습니다")
    files = [{"file": str(summary_path.relative_to(root)), "sha256": digest(summary_path)}]
    for w in windows:
        path = summary_path.with_name(f'{candidate["id"]}__{w["start"]}.json')
        run = json.loads(path.read_text())
        if (run.get("status") == "failed" or run["summary"] != w or run["candidate"] != candidate or run["options"] != options
                or run["stage"] != stage or any(run[k] != v for k, v in hashes.items())
                or run["risk"]["stopPct"] != stop or run["risk"]["targetPct"] != 10.5 or run["risk"]["initialCash"] != 100_000_000
                or run["seed"] != seed or run["slippageBps"] != slippage or run["engineVersion"] != "2.12.0"
                or run["strategyVersion"] != "2.2.1+history-reset.1"
                or run["parameters"] != {"formationDays": 20, "skipDays": 0, "topN": 5, "absoluteMomentumFilter": True}
                or w["end"] != end_of_quarter(w["start"]) or run["result"]["metrics"]["totalReturnPct"] != w["returnPct"]
                or (len(run["result"]["openPositions"]) == 0) != w["closed"]
                or w["targetReached"] != (w["closed"] and not w["affectedActions"] and w["returnPct"] >= 10)):
            raise ValueError(f"원본 계좌의 설정·성과 불일치: {path}")
        points = run["result"]["equityPoints"]
        if not math.isclose((points[-1]["equity"] / 100_000_000 - 1) * 100, w["returnPct"], rel_tol=1e-10, abs_tol=1e-8):
            raise ValueError("마지막 실제 평가액과 수익 불일치")
        for event in w["riskEvents"]:
            eligible = [p["equity"] for p in points if datetime.fromtimestamp(p["tsMs"] / 1000, timezone.utc).strftime("%Y-%m-%d") <= event["date"]]
            if event["reason"] == "계좌 낙폭 중단" and event["equity"] > max(100_000_000, *eligible) * (1 - stop / 100) + 1e-6:
                raise ValueError("기록한 중단 시점의 평가액이 설정한 낙폭 조건과 다릅니다")
        files.append({"file": str(path.relative_to(root)), "sha256": digest(path)})
    for key, rows in (("all", summary["windows"]), ("nonoverlapping", nonoverlapping(summary["windows"]))):
        actual = summarize(rows)
        if set(actual) != set(summary[key]) or any(not math.isclose(v, summary[key][k], rel_tol=1e-10, abs_tol=1e-8) for k, v in actual.items()):
            raise ValueError("계좌로 재계산한 원래 요약의 통계 불일치")
    return windows, files


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    cfg = Path(__file__).parent / "configs"
    candidate_path = cfg / "account-stop-candidate.json"
    candidate = json.loads(candidate_path.read_text())[0]
    experiments_path = cfg / "account-stop-experiments.json"
    experiments = json.loads(experiments_path.read_text())
    input_path = root / "expanded/stock-200-verified-input.json.gz"
    sources = {candidate_path, experiments_path, input_path}
    records, files, baseline = [], [], {}
    for stage in ("validation", "confirmation"):
        fixed_path = cfg / f"entry-30-{stage}-options.json"
        options_path = cfg / f"entry-{stage}-options.json"
        starts = json.loads(fixed_path.read_text())["starts"]
        windows, checked = verify(root, f"entry/daily-{stage}", candidate, stage, options_path, input_path, 10, starts)
        baseline[stage] = {w["start"]: w for w in windows}
        files.extend(checked)
        sources.update((fixed_path, options_path))
        records.append({"stage": stage, "accountStopPct": 10, "reused": True, "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows})
    for e in experiments:
        options_path = cfg / e["options"]
        options = json.loads(options_path.read_text())
        frozen = json.loads((cfg / f'entry-30-{e["stage"]}-options.json').read_text())
        if options != frozen | {"accountStopPct": e["accountStopPct"]} or e["input"] != str(input_path.relative_to(root)) or e["selection"] != candidate_path.name:
            raise ValueError("중단 기준 이외에 고정한 실험 설정이 달라졌습니다")
        windows, checked = verify(root, e["directory"], candidate, e["stage"], options_path, input_path, e["accountStopPct"], options["starts"])
        files.extend(checked)
        sources.add(options_path)
        pairs = [{"start": w["start"], "baseReturnPct": baseline[e["stage"]][w["start"]]["returnPct"], "returnPct": w["returnPct"],
                  "returnDeltaPctPoints": w["returnPct"] - baseline[e["stage"]][w["start"]]["returnPct"],
                  "baseTargetReached": baseline[e["stage"]][w["start"]]["targetReached"], "targetReached": w["targetReached"]} for w in windows]
        records.append({"stage": e["stage"], "accountStopPct": e["accountStopPct"], "reused": False, "all": summarize(windows),
                        "nonoverlapping": summarize(nonoverlapping(windows)), "paired": pairs, "windows": windows})
    (destination / "all-results.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    flat = [{k: r[k] for k in ("stage", "accountStopPct", "reused")} | r["all"] | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in records]
    with (destination / "all-summaries.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(flat)
    compact_fields = ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "riskEvents", "affectedActions")
    compact = [{k: v for k, v in r.items() if k not in ("windows", "paired")} | {"windows": [{k: w[k] for k in compact_fields} for w in nonoverlapping(r["windows"])]} for r in records]
    (destination / "nonoverlapping-accounts.json").write_text(json.dumps(compact, ensure_ascii=False, indent=2) + "\n")
    paired = [{k: r[k] for k in ("stage", "accountStopPct", "paired")} for r in records if not r["reused"]]
    (destination / "paired-accounts.json").write_text(json.dumps(paired, ensure_ascii=False, indent=2) + "\n")
    code = [Path(__file__), Path(__file__).with_name("analyze_context.py"), Path(__file__).with_name("prepare_entry_dates.py"), Path("pnpm-lock.yaml")]
    code += list(Path(__file__).parent.glob("*.ts")) + list(Path("src/server/modules/backtest/domain").glob("*.ts")) + list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "d5995a2", "newExperiments": len(experiments), "newAccounts": sum(r["all"]["count"] for r in records if not r["reused"]),
                "reusedAccounts": sum(r["all"]["count"] for r in records if r["reused"]), "files": files,
                "sourceSha256": {str(p): digest(p) for p in sorted(sources)}, "codeSha256": {str(p): digest(p) for p in sorted(set(code))}}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    evidence = {k: v for k, v in manifest.items() if k != "files"} | {"manifestSha256": digest(destination / "manifest.json")}
    (destination / "evidence-manifest.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: manifest[k] for k in ("newExperiments", "newAccounts", "reusedAccounts")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
