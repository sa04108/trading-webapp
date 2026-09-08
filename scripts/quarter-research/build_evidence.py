"""완료된 전체 탐색의 요약·해시·현재 신호와 공유용 그림을 생성한다."""

import argparse
import csv
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from analyze_context import analyze


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    config = Path(__file__).parent / "configs"
    experiments = json.loads((config / "experiments.json").read_text())
    records = []
    files = []
    for experiment in experiments:
        candidates = json.loads((config / experiment["selection"]).read_text())
        for candidate in candidates:
            source = root / experiment["directory"] / f'{candidate["id"]}__summary.json'
            trial = json.loads(source.read_text())
            if len(trial["windows"]) != trial["all"]["count"]:
                raise ValueError(f"요약과 실행 수 불일치: {source}")
            for window in trial["windows"]:
                run = source.parent / f'{candidate["id"]}__{window["start"]}.json'
                raw = run.read_bytes()
                full = json.loads(raw)
                if full.get("status") == "failed" or full["summary"] != window:
                    raise ValueError(f"실패 또는 요약 불일치: {run}")
                files.append({"file": str(run.relative_to(root)), "sha256": hashlib.sha256(raw).hexdigest()})
            files.append({"file": str(source.relative_to(root)), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
            records.append({"directory": experiment["directory"], "candidate": candidate, "stage": trial["stage"],
                            "all": trial["all"], "nonoverlapping": trial["nonoverlapping"], "inputSha256": trial["inputSha256"],
                            "windows": trial["windows"]})
    (destination / "all-summaries.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    flat = [{"directory": r["directory"], "candidate": r["candidate"]["id"], "stage": r["stage"], **r["all"],
             **{f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()}} for r in records]
    with (destination / "all-summaries.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(flat[0]))
        writer.writeheader()
        writer.writerows(flat)
    analyze(root, [e["directory"] for e in experiments], destination / "context-analysis.json")
    contexts = json.loads((destination / "context-analysis.json").read_text())["records"]
    context_rows = [{"directory": r["directory"], "candidate": r["candidate"]["id"], "condition": r["condition"],
                     **r["all"], **{f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()}}
                    for r in contexts]
    with (destination / "context-summary.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(context_rows[0]))
        writer.writeheader()
        writer.writerows(context_rows)
    for name in ("current-state.json", "current-signals.json"):
        (destination / name).write_bytes((root / name).read_bytes())
    code = sorted(Path(__file__).parent.rglob("*"))
    code += sorted(Path("src/server/modules/backtest/domain").glob("*.ts"))
    code += sorted(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    code += sorted(Path("src/server/modules/facts/domain").glob("*.ts"))
    code += sorted(Path("tests/unit").glob("*quarter*.test.ts"))
    code_hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in code
                   if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"}
    manifest = {"asof": "2026-09-08", "baseCommit": "535c4d7", "summaryCount": len(records),
                "developmentConfigurations": sum(r["stage"] == "development" for r in records),
                "completedQuarterAccounts": sum(r["all"]["count"] for r in records),
                "files": files, "codeSha256": code_hashes,
                "note": "계좌 창은 중첩되며 독립 표본 수가 아니다. 최초 중단 실패와 smoke·재현·민감도 실행은 이 수에 포함하지 않는다."}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    compact = {k: v for k, v in manifest.items() if k != "files"}
    compact["resultManifestSha256"] = hashlib.sha256((destination / "manifest.json").read_bytes()).hexdigest()
    compact["resultSetSha256"] = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    (destination / "evidence-manifest.json").write_text(json.dumps(compact, ensure_ascii=False, indent=2) + "\n")
    chart(records, destination)
    print(json.dumps({k: manifest[k] for k in ("summaryCount", "developmentConfigurations", "completedQuarterAccounts")}))


def chart(records, destination):
    plt.rcParams["svg.hashsalt"] = "kr-quarter-20260908"
    families = [("momentum-20-5-monthly", "Momentum 20 / 5"), ("recovery-60-3-monthly", "Recovery 60 / 3"),
                ("quality-60-15", "Annual quality 60 / 15%"), ("rsi-5-30", "RSI 5 / 30")]
    stage_names = ["validation", "confirmation"]
    colors = ["#5275B8", "#CA793A"]
    figure, axes = plt.subplots(1, 2, figsize=(12, 5), layout="constrained")
    y = np.arange(len(families))
    for stage_i, stage in enumerate(stage_names):
        for i, (candidate, _) in enumerate(families):
            match = next(r for r in records if r["candidate"]["id"] == candidate and r["stage"] == stage and "etf" not in r["directory"])
            values = match["all"]
            row_y = y[i] + (stage_i - .5) * .3
            axes[0].barh(row_y, values["targetFrequencyPct"], height=.25, color=colors[stage_i], label=stage if i == 0 else None)
            axes[0].text(values["targetFrequencyPct"] + 1, row_y, f'{values["targetHits"]}/{values["count"]}', va="center", fontsize=9)
            axes[1].plot([values["p10Pct"], values["medianPct"]], [row_y] * 2, color=colors[stage_i], linewidth=3)
            axes[1].scatter(values["medianPct"], row_y, color=colors[stage_i], s=40)
    axes[0].axvline(50, color="#777777", linestyle=":", linewidth=1)
    axes[0].set_xlim(0, 65)
    axes[0].set_xlabel("Realized return >= 10%: historical frequency (%)")
    axes[1].axvline(10, color="#777777", linestyle=":", linewidth=1)
    axes[1].set_xlabel("3-month net return (%): 10th percentile to median")
    for axis in axes:
        axis.set_yticks(y, [name for _, name in families])
        axis.invert_yaxis()
        axis.spines[["top", "right"]].set_visible(False)
        axis.grid(axis="x", alpha=.15)
        axis.set_axisbelow(True)
    axes[0].legend(loc="lower right", fontsize=9)
    axes[1].set_yticklabels([])
    figure.suptitle("Korean stock strategies: frozen base candidates", fontsize=14)
    figure.savefig(destination / "quarter-outcomes.png", dpi=180, metadata={"Software": "matplotlib"})
    figure.savefig(destination / "quarter-outcomes.svg", metadata={"Date": None})
    svg = destination / "quarter-outcomes.svg"
    svg.write_text("\n".join(line.rstrip() for line in svg.read_text().splitlines()) + "\n")
    plt.close(figure)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
