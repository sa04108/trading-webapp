"""회복 기간 단축 실험과 동일 조건의 기존 계좌를 대조한다."""

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path

from analyze_context import nonoverlapping, summarize


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    config = Path(__file__).parent / "configs"
    experiments = json.loads((config / "faster-recovery-experiments.json").read_text())
    records, files, sources = [], [], set()
    for experiment in experiments:
        selection = config / experiment["selection"]
        options_path = config / experiment["options"]
        input_path = root / experiment["input"]
        sources.update((selection, options_path, input_path))
        candidate, = json.loads(selection.read_text())
        options = json.loads(options_path.read_text())
        summary_path = root / experiment["directory"] / f'{candidate["id"]}__summary.json'
        trial = json.loads(summary_path.read_text())
        if (trial["candidate"] != candidate or trial["stage"] != experiment["stage"]
                or trial["options"] != options or trial["optionsSha256"] != digest(options_path)
                or trial["inputSha256"] != digest(input_path)):
            raise ValueError(f"고정 후보·옵션·입력 불일치: {summary_path}")
        expected_count = {"development": 46, "validation": 19, "confirmation": 58}[experiment["stage"]]
        if len(trial["windows"]) != expected_count or ("starts" in options and [w["start"] for w in trial["windows"]] != options["starts"]):
            raise ValueError("고정 시작점 일부가 빠졌습니다")
        for window in trial["windows"]:
            path = summary_path.with_name(f'{candidate["id"]}__{window["start"]}.json')
            run = json.loads(path.read_text())
            expected_parameters = {"formationDays": candidate["parameters"]["formationDays"], "topN": candidate["topN"],
                                   "targetAnnualVolatility": .3, "positionStopPct": 8}
            if (run.get("status") == "failed" or run["summary"] != window or run["candidate"] != candidate
                    or run["parameters"] != expected_parameters or run["stage"] != experiment["stage"]
                    or run["inputSha256"] != trial["inputSha256"] or run["optionsSha256"] != trial["optionsSha256"]
                    or run["options"] != options or run["seed"] != experiment["seed"] or run["slippageBps"] != experiment["slippageBps"]
                    or run["risk"]["initialCash"] != 100_000_000 or run["risk"]["targetPct"] != 10.5 or run["risk"]["stopPct"] != 10
                    or run["engineVersion"] != "2.12.0" or run["strategyVersion"] != "0.1.0+history-reset.1"):
                raise ValueError(f"실행 계좌의 설정·결과 불일치: {path}")
            files.append({"file": str(path.relative_to(root)), "sha256": digest(path)})
        for key, rows in (("all", trial["windows"]), ("nonoverlapping", nonoverlapping(trial["windows"]))):
            calculated = summarize(rows)
            if set(calculated) != set(trial[key]) or any(not math.isclose(v, trial[key][k], rel_tol=1e-10, abs_tol=1e-8) for k, v in calculated.items()):
                raise ValueError("원본에서 재계산한 통계 불일치")
        files.append({"file": str(summary_path.relative_to(root)), "sha256": digest(summary_path)})
        records.append({"formationDays": candidate["parameters"]["formationDays"], "topN": candidate["topN"], "stage": trial["stage"], "reused": False,
                        "directory": experiment["directory"], "all": trial["all"], "nonoverlapping": trial["nonoverlapping"], "windows": trial["windows"]})
    for formation, stage, directory in ((60, "development", "entry/monthly-development"), (60, "validation", "entry/daily-validation"),
                                         (60, "confirmation", "entry/daily-confirmation"), (40, "validation", "entry/daily-validation"),
                                         (40, "confirmation", "entry/daily-confirmation")):
        path = root / directory / f"recovery-{formation}-3-monthly__summary.json"
        trial = json.loads(path.read_text())
        if trial["inputSha256"] != digest(root / "expanded/stock-200-verified-input.json.gz") or not trial["options"]["resetUncertainHistory"]:
            raise ValueError("재사용 기본 후보의 가격 입력·이력 처리 불일치")
        options_path = config / ("history-reset-options.json" if stage == "development" else f"entry-30-{stage}-options.json")
        expected_starts = json.loads(options_path.read_text()).get("starts")
        windows = [w for w in trial["windows"] if expected_starts is None or w["start"] in expected_starts]
        if [w["start"] for w in windows] != [w["start"] for w in next(r for r in records if r["stage"] == stage)["windows"]]:
            raise ValueError("기본 후보와 기간 단축 후보의 시작점이 다릅니다")
        for window in windows:
            run_path = path.with_name(f'recovery-{formation}-3-monthly__{window["start"]}.json')
            run = json.loads(run_path.read_text())
            if (run["summary"] != window or run["parameters"] != {"formationDays": formation, "topN": 3, "targetAnnualVolatility": .3, "positionStopPct": 8}
                    or run["seed"] != 204 or run["slippageBps"] != 5 or run["inputSha256"] != trial["inputSha256"]
                    or run["risk"]["initialCash"] != 100_000_000 or run["risk"]["targetPct"] != 10.5 or run["risk"]["stopPct"] != 10
                    or run["engineVersion"] != "2.12.0" or run["strategyVersion"] != "0.1.0+history-reset.1"):
                raise ValueError("재사용한 기본 계좌의 원본 불일치")
            sources.add(run_path)
        sources.add(path)
        records.append({"formationDays": formation, "topN": 3, "stage": stage, "reused": True, "directory": directory,
                        "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows})
    records.sort(key=lambda r: (r["formationDays"], r["topN"], {"development": 0, "validation": 1, "confirmation": 2}[r["stage"]]))
    (destination / "all-summaries.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    flat = [{k: v for k, v in r.items() if k not in ("all", "nonoverlapping", "windows")} | r["all"]
            | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in records]
    with (destination / "all-summaries.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(flat)
    fields = ("start", "end", "returnPct", "drawdownPct", "targetReached", "closed", "trades", "fills", "riskEvents", "affectedActions")
    compact = [{k: v for k, v in r.items() if k != "windows"} | {
        "windows": [{k: w[k] for k in fields} for w in nonoverlapping(r["windows"])]} for r in records]
    (destination / "nonoverlapping-accounts.json").write_text(json.dumps(compact, ensure_ascii=False, indent=2) + "\n")
    code = list(Path(__file__).parent.glob("*.ts")) + [Path(__file__), Path(__file__).with_name("analyze_context.py"), Path("pnpm-lock.yaml")]
    code += list(Path("src/server/modules/backtest/domain").glob("*.ts"))
    code += list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "bc99bbd", "newExperiments": len(experiments),
                "newCompletedAccounts": sum(r["all"]["count"] for r in records if not r["reused"]),
                "reusedCompletedAccounts": sum(r["all"]["count"] for r in records if r["reused"]),
                "files": files, "sourceSha256": {str(p): digest(p) for p in sorted(sources)},
                "codeSha256": {str(p): digest(p) for p in sorted(set(code)) if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"}}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    compact_manifest = {k: v for k, v in manifest.items() if k != "files"}
    compact_manifest["manifestSha256"] = digest(destination / "manifest.json")
    compact_manifest["resultSetSha256"] = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    (destination / "evidence-manifest.json").write_text(json.dumps(compact_manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: manifest[k] for k in ("newExperiments", "newCompletedAccounts", "reusedCompletedAccounts")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
