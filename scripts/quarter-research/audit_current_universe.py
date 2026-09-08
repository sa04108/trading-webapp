"""월별 종목군의 자료 시점과 현재 모멘텀 신호를 원문·실제 일봉으로 대조한다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import subprocess

from build_account_stop_evidence import digest


def audit(root, destination):
    folder = root / "target-retry-neighbors/current-universe"
    source_path = root / "expanded/source/input-200.json.gz"
    historical = json.loads(gzip.decompress(source_path.read_bytes()))
    calendar_path = root / "etf-input.json.gz"
    market = json.loads(gzip.decompress(calendar_path.read_bytes()))
    source_days = [r["date"] for r in historical["macro"]]
    overlap_start = max(source_days[0], market["days"][0])
    prefix_matches = [d for d in source_days if overlap_start <= d <= "2026-08-14"] == [d for d in market["days"] if overlap_start <= d <= "2026-08-14"]
    # 거시 달력이 시작되기 전의 원래 일정 기준점을 보존하고 이후 결손 거래일을 채운다.
    calendar = [d for d in source_days if d <= "2026-08-14"] + [d for d in market["days"] if "2026-08-14" < d <= "2026-09-08"]
    if not prefix_matches:
        raise ValueError("검증된 과거 구간의 원래 거래일과 현재 달력의 불일치")
    stamp = lambda d: int(datetime.fromisoformat(d).replace(tzinfo=timezone.utc).timestamp() * 1000)
    expected_schedule = [stamp(d) for i, d in enumerate(source_days) if i >= 21 and (i - 21) % 5 == 0]
    if [s["fromTsMs"] for s in historical["schedule"]] != expected_schedule:
        raise ValueError("원래 입력의 5봉 종목군 게시 일정이 보존 코드와 다릅니다")
    lookup_date = calendar[-2]
    latest_schedule = next(d for i, d in reversed(list(enumerate(calendar[:-1]))) if i >= 21 and (i - 21) % 5 == 0)
    month_index = next(i for i, d in enumerate(calendar) if d[:7] == latest_schedule[:7])
    selection_date = calendar[month_index - 1]
    original_manifest = root / "expanded/current-liquid-manifest.json"
    default_path, monthly_path = folder / "default-manifest.json", folder / "monthly-manifest.json"
    if default_path.read_bytes() != original_manifest.read_bytes():
        raise ValueError("기본 현재 선정 결과가 이전 원본과 달라졌습니다")
    daily, monthly = json.loads(default_path.read_text()), json.loads(monthly_path.read_text())
    if monthly["asof"] != "2026-09-08" or selection_date != "2026-08-31" or monthly["liquidityAudit"]["days"][-1] != selection_date:
        raise ValueError("원래 월별 선정 시점과 현재 신호일을 분리하지 못했습니다")
    old, new = {r["symbol"]: r for r in daily["selected"]}, {r["symbol"]: r for r in monthly["selected"]}
    if len(new) != 200 or any(r["universeAsOf"] != selection_date or r["selectionAdv20"] < 1_000_000_000 for r in new.values()):
        raise ValueError("현재 종목군의 크기·자료 시점·거래대금 조건 불일치")
    input_path, signals_path = folder / "monthly-input.json.gz", folder / "monthly-signals.json"
    current = json.loads(gzip.decompress(input_path.read_bytes()))
    signals = json.loads(signals_path.read_text())
    previous_signals_path = root / "account-stop/current-signals.json"
    previous_signals = json.loads(previous_signals_path.read_text())
    if (signals["inputSha256"] != digest(input_path) or signals["sources"]["manifestSha256"] != digest(monthly_path)
            or signals["asof"] != monthly["asof"] or current["currentSymbols"] != monthly["selected"]
            or any(set(members) != set(new) for members in current["members"])):
        raise ValueError("현재 입력·선정 원문·신호의 불일치")
    result = signals["signals"][0]
    targets = result["pendingTargets"]
    ranked = sorted([r for r in signals["diagnostics"] if r["return20"] is not None and r["return20"] > 0], key=lambda r: (-r["return20"], r["symbol"]))
    if set(targets) != {r["symbol"] for r in ranked[:5]} or result["ordersAtLatestClose"]:
        raise ValueError("상위 순위 또는 현재 선정·주문 단계의 불일치")
    target_rows = []
    for symbol in targets:
        row = next(r for r in signals["diagnostics"] if r["symbol"] == symbol)
        bars = sorted([c for c in current["candles"] if c["symbol"] == symbol], key=lambda c: c["tsMs"])[-21:]
        if len(bars) != 21 or not math.isclose(bars[-1]["close"] / bars[0]["close"] - 1, row["return20"], rel_tol=1e-12):
            raise ValueError("실제 21개 종가로 재계산한 현재 순위 점수 불일치")
        events = [e for e in current["metadata"]["currentHistoryQuarantines"] if e["symbol"] == symbol]
        if any(stamp(e["date"]) >= bars[0]["tsMs"] for e in events):
            raise ValueError("현재 순위의 실제 일봉이 미확인 사건 이전까지 연결됐습니다")
        target_rows.append({k: row[k] for k in ("symbol", "name", "close", "return20", "annualVol20", "selectionMarketCap", "selectionAdv20", "universeAsOf")} | {
            "firstScoreBar": datetime.fromtimestamp(bars[0]["tsMs"] / 1000, timezone.utc).strftime("%Y-%m-%d"),
            "lastScoreBar": datetime.fromtimestamp(bars[-1]["tsMs"] / 1000, timezone.utc).strftime("%Y-%m-%d"), "unresolvedEvents": events})
    historical_code = subprocess.check_output(["git", "show", "ebc7936:scripts/research/prepare_kr_regimes.py"])
    sources = {str(p): digest(p) for p in (source_path, calendar_path, original_manifest, default_path, monthly_path, input_path, signals_path, previous_signals_path)}
    for name, value in monthly["liquidityAudit"]["sourceSha256"].items():
        if digest(Path(name)) != value:
            raise ValueError("월말 선정에 사용한 원문 또는 저장 패널이 바뀌었습니다")
        sources[name] = value
    output = {"asof": "2026-09-08", "oldUniverseAsOf": daily["liquidityAudit"]["days"][-1], "monthlyUniverseAsOf": selection_date,
              "membershipLookupDate": lookup_date, "projectedLatestSourceSchedule": latest_schedule, "historicalCalendarPrefixMatchesFrom": overlap_start, "historicalCalendarPrefixMatchesThrough": "2026-08-14",
              "missingStoredDatesAfterValidatedCutoff": [d for d in calendar if "2026-08-14" < d <= source_days[-1] and d not in source_days],
              "defaultManifestByteEqual": True, "commonMembers": len(set(old) & set(new)),
              "onlyDaily": [{"symbol": s, "name": old[s]["name"]} for s in sorted(set(old) - set(new))],
              "onlyMonthly": [{"symbol": s, "name": new[s]["name"]} for s in sorted(set(new) - set(old))],
              "signalsEqual": signals["signals"] == previous_signals["signals"], "targets": target_rows,
              "currentInputCandles": len(current["candles"]), "currentHistoryQuarantines": current["metadata"]["currentHistoryQuarantines"],
              "currentInputSources": current["metadata"]["currentSources"], "sourceSha256": sources,
              "historicalBuilderCommit": "ebc7936", "historicalBuilderSha256": hashlib.sha256(historical_code).hexdigest(),
              "codeSha256": {str(p): digest(p) for p in (Path(__file__), Path(__file__).with_name("select_current_krx.py"),
                Path(__file__).with_name("test_current_selection.py"), Path(__file__).with_name("prepare_current_inputs.py"),
                Path(__file__).with_name("prepare_stock_inputs.py"), Path(__file__).with_name("current-signals.ts"), Path(__file__).with_name("quarter-engine.ts"))},
              "note": "현재 관찰의 종목군 시점을 과거 월별 규칙에 맞춘 결과이며 실전 채택·미래 수익 확인·주문 발송이 아니다."}
    destination.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: output[k] for k in ("monthlyUniverseAsOf", "projectedLatestSourceSchedule", "commonMembers", "signalsEqual", "currentInputCandles")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    audit(args.root, args.destination)
