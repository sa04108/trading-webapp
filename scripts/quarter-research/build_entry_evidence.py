"""고정 시작점·가격 이력 처리·확인 대기 결과를 이전 연구와 분리해 대조한다."""

import argparse
import csv
from collections import Counter
import hashlib
import json
import math
from pathlib import Path

from analyze_context import nonoverlapping, summarize


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_csv(path, rows):
    with path.open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(dict.fromkeys(k for row in rows for k in row)), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    config = Path(__file__).parent / "configs"
    experiments = json.loads((config / "entry-experiments.json").read_text())
    records, files, sources = [], [], set()
    for experiment in experiments:
        input_path = root / experiment["input"]
        options_path = config / experiment["options"]
        options = json.loads(options_path.read_text())
        expected_input, expected_options = digest(input_path), digest(options_path)
        sources.update((input_path, options_path, config / experiment["selection"]))
        for candidate in json.loads((config / experiment["selection"]).read_text()):
            summary_path = root / experiment["directory"] / f'{candidate["id"]}__summary.json'
            trial = json.loads(summary_path.read_text())
            if (trial["candidate"] != candidate or trial["stage"] != experiment["stage"]
                    or trial["inputSha256"] != expected_input or trial["optionsSha256"] != expected_options
                    or trial["options"] != options):
                raise ValueError(f"고정 입력·후보·옵션과 요약 불일치: {summary_path}")
            if "starts" in options and [w["start"] for w in trial["windows"]] != options["starts"]:
                raise ValueError("고정한 모든 시작점을 실행하지 않았습니다")
            for window in trial["windows"]:
                path = summary_path.with_name(f'{candidate["id"]}__{window["start"]}.json')
                run = json.loads(path.read_text())
                if (run.get("status") == "failed" or run["summary"] != window or run["candidate"] != candidate
                        or run["inputSha256"] != expected_input or run["optionsSha256"] != expected_options
                        or run["options"] != options or run["stage"] != experiment["stage"]
                        or run["seed"] != experiment["seed"] or run["slippageBps"] != experiment["slippageBps"]
                        or run["risk"]["initialCash"] != 100_000_000 or run["risk"]["targetPct"] != 10.5
                        or run["risk"]["stopPct"] != 10 or run["engineVersion"] != "2.12.0"):
                    raise ValueError(f"실행 계좌의 설정·결과 불일치: {path}")
                files.append({"file": str(path.relative_to(root)), "sha256": digest(path)})
            for key, rows in (("all", trial["windows"]), ("nonoverlapping", nonoverlapping(trial["windows"]))):
                calculated = summarize(rows)
                if set(calculated) != set(trial[key]) or any(not math.isclose(v, trial[key][k], rel_tol=1e-10, abs_tol=1e-8) for k, v in calculated.items()):
                    raise ValueError(f"전체 계좌에서 재계산한 통계와 요약 불일치: {summary_path}")
            records.append({"experiment": experiment, "candidate": candidate, "optionsSha256": expected_options,
                            "all": trial["all"], "nonoverlapping": trial["nonoverlapping"], "windows": trial["windows"]})
            files.append({"file": str(summary_path.relative_to(root)), "sha256": digest(summary_path)})
    (destination / "all-summaries.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    write_csv(destination / "all-summaries.csv", [{**r["experiment"], "candidate": r["candidate"]["id"], **r["all"],
              **{f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()}} for r in records])
    conditions = []
    for record in records:
        options = json.loads((config / record["experiment"]["options"]).read_text())
        if "starts" not in options:
            continue
        for threshold in (.25, .30, .35):
            if threshold < options["dateSelection"]["minimumVolatility"]:
                continue
            rows = [w for w in record["windows"] if w["startState"]["kospiVol20"] >= threshold]
            conditions.append({"directory": record["experiment"]["directory"], "stage": record["experiment"]["stage"],
                               "candidate": record["candidate"]["id"], "threshold": threshold,
                               "all": summarize(rows), "nonoverlapping": summarize(nonoverlapping(rows)),
                               "nonoverlappingStarts": [w["start"] for w in nonoverlapping(rows)], "windows": rows})
    (destination / "conditions.json").write_text(json.dumps(conditions, ensure_ascii=False, indent=2) + "\n")
    write_csv(destination / "conditions.csv", [{k: v for k, v in r.items() if k not in ("all", "nonoverlapping", "windows", "nonoverlappingStarts")}
              | r["all"] | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in conditions])
    compact_fields = ("start", "end", "returnPct", "drawdownPct", "targetReached", "closed", "trades", "fills", "activation", "affectedActions", "riskEvents")
    compact_rows = [{k: v for k, v in record.items() if k != "windows"} | {
        "windows": [{k: w[k] for k in compact_fields if k in w} for w in nonoverlapping(record["windows"])]
    } for record in conditions]
    (destination / "nonoverlapping-accounts.json").write_text(json.dumps(compact_rows, ensure_ascii=False, indent=2) + "\n")
    exits = []
    for record in conditions:
        if (record["threshold"] != .30 or record["candidate"] != "recovery-60-3-monthly"
                or record["directory"] not in ("entry/daily-validation", "entry/daily-confirmation")):
            continue
        for window in nonoverlapping(record["windows"]):
            run = json.loads((root / record["directory"] / f'recovery-60-3-monthly__{window["start"]}.json').read_text())
            exits.append({k: window[k] for k in compact_fields if k in window} | {
                "stage": record["stage"], "sellFillReasons": dict(Counter(f.get("reason", "미기재") for f in run["result"]["fills"] if f["side"] == "SELL"))})
    (destination / "first-entry-exits.json").write_text(json.dumps(exits, ensure_ascii=False, indent=2) + "\n")
    comparisons = []
    for stage, old_directory in (("development", "expanded/development-verified"), ("validation", "expanded/validation"), ("confirmation", "expanded/confirmation")):
        original_path = root / old_directory / "recovery-60-3-monthly__summary.json"
        original = json.loads(original_path.read_text())
        updated = next(r for r in records if r["experiment"]["directory"] == f"entry/monthly-{stage}")
        if [w["start"] for w in original["windows"]] != [w["start"] for w in updated["windows"]]:
            raise ValueError("월간 대조 계좌 시작점이 다릅니다")
        changed = [{"start": before["start"], "beforePct": before["returnPct"], "afterPct": after["returnPct"],
                    "beforeHit": before["targetReached"], "afterHit": after["targetReached"]}
                   for before, after in zip(original["windows"], updated["windows"]) if abs(before["returnPct"] - after["returnPct"]) > 1e-8]
        comparisons.append({"stage": stage, "originalSha256": digest(original_path), "before": original["all"], "after": updated["all"],
                            "beforeNonoverlapping": original["nonoverlapping"], "afterNonoverlapping": updated["nonoverlapping"], "changed": changed})
        sources.add(original_path)
    (destination / "monthly-comparison.json").write_text(json.dumps(comparisons, ensure_ascii=False, indent=2) + "\n")
    sources.add(root / "entry/date-audit.json")
    code = list(Path(__file__).parent.rglob("*")) + list(Path("src/server/modules/backtest/domain").glob("*.ts"))
    code += list(Path("src/server/modules/strategy/strategies").rglob("*.ts")) + list(Path("tests/unit").glob("*quarter*.test.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "214365a", "summaryCount": len(records),
                "completedQuarterAccounts": sum(r["all"]["count"] for r in records), "files": files,
                "sourceSha256": {str(p): digest(p) for p in sorted(sources)},
                "codeSha256": {str(p): digest(p) for p in sorted(set(code)) if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"},
                "note": "같은 시장 이력을 재사용한 진단과 추가 가설이다. 확인 대기에도 원래 계좌 만기를 유지하고 실패·미청산·무거래를 제외하지 않는다."}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    compact = {k: v for k, v in manifest.items() if k != "files"}
    compact["manifestSha256"] = digest(destination / "manifest.json")
    compact["resultSetSha256"] = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    (destination / "evidence-manifest.json").write_text(json.dumps(compact, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"summaryCount": len(records), "completedQuarterAccounts": manifest["completedQuarterAccounts"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
