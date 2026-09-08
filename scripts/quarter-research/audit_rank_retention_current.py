"""현재 보유 순위 후보의 실제 신호·원문 점수·기존 관찰과의 일치를 확인한다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit(root, output):
    current = root / "rank-retention-current"
    previous = root / "target-retry-neighbors/current-universe"
    input_path = previous / "monthly-input.json.gz"
    data = json.loads(gzip.decompress(input_path.read_bytes()))
    signal_path = current / "current-signals.json"
    signal = json.loads(signal_path.read_text())
    native_path = current / "native-replay.json"
    old_native = previous / "monthly-signals.json"
    previous_audit = json.loads((previous / "audit.json").read_text())
    monthly_path = previous / "monthly-manifest.json"
    monthly = json.loads(monthly_path.read_text())
    previous_hashes = {Path(p).resolve(): value for p, value in previous_audit["sourceSha256"].items()}
    if (previous_audit["asof"] != data["asof"]
            or monthly["liquidityAudit"]["days"][-1] != previous_audit["monthlyUniverseAsOf"]
            or any(digest(p) != previous_hashes.get(p.resolve()) for p in (input_path, monthly_path, old_native))):
        raise ValueError("앞서 검증한 월별 종목군·현재 입력의 원본이 달라졌습니다")
    if native_path.read_bytes() != old_native.read_bytes():
        raise ValueError("기존 현재 모멘텀 관찰의 바이트 재현 불일치")
    native = json.loads(native_path.read_text())
    selection_path = Path(__file__).parent / "configs/rank-retention-20.json"
    candidate = json.loads(selection_path.read_text())[0]
    expected = {"id": "rank-retention-20", "strategyId": "rank-retention-momentum", "topN": 5, "rebalanceBars": 20,
                "parameters": {"formationDays": 20, "skipDays": 0, "topN": 5, "retentionRank": 10}}
    if candidate != expected or len(signal["signals"]) != 1:
        raise ValueError("고정한 기본 후보의 현재 관찰이 아닙니다")
    observed = signal["signals"][0]
    if (signal["asof"] != data["asof"] or signal["inputSha256"] != digest(input_path)
            or signal["engineVersion"] != "2.12.0" or signal["initialCash"] != 100_000_000
            or observed["candidate"] != candidate or observed["parameters"] != candidate["parameters"] | {"absoluteMomentumFilter": True}
            or observed["ordersAtLatestClose"] != [] or signal["diagnostics"] != native["diagnostics"]
            or observed["pendingTargets"] != native["signals"][0]["pendingTargets"]
            or signal["historyQuarantines"] != data["metadata"]["currentHistoryQuarantines"]):
        raise ValueError("현재 원본·후보·선정 단계·진단의 대조 불일치")
    ts = int(datetime.fromisoformat(data["asof"]).replace(tzinfo=timezone.utc).timestamp() * 1000)
    if any(bar["tsMs"] > ts for bar in data["candles"]):
        raise ValueError("관찰일 이후 가격이 있습니다")
    halted = {symbol for time, names in data["nontrading"] if time == ts for symbol in names}
    details = signal["diagnostics"]
    if {d["symbol"] for d in details} != {s["symbol"] for s in data["currentSymbols"]}:
        raise ValueError("현재 종목군과 진단 대상이 다릅니다")
    ranked = sorted((d for d in details if d["symbol"] not in halted and d["return20"] is not None and d["return20"] > 0),
                    key=lambda d: (-d["return20"], d["symbol"]))
    if len(ranked) <= 5 or ranked[4]["return20"] == ranked[5]["return20"]:
        raise ValueError("현재 순위 경계의 동점 또는 적격 종목 부족은 별도 엔진 대조가 필요합니다")
    if sorted(d["symbol"] for d in ranked[:5]) != observed["pendingTargets"]:
        raise ValueError("현금 시작의 실제 목표가 현재 상위 다섯 종목과 다릅니다")
    targets = []
    for rank, detail in enumerate(ranked[:5], 1):
        bars = sorted((b for b in data["candles"] if b["symbol"] == detail["symbol"]), key=lambda b: b["tsMs"])[-21:]
        raw_score = bars[-1]["close"] / bars[0]["close"] - 1
        if (len(bars) != 21 or bars[-1]["tsMs"] != ts or detail["lastBarTsMs"] != ts
                or not math.isclose(raw_score, detail["return20"], rel_tol=1e-10, abs_tol=1e-10)):
            raise ValueError("목표 종목의 실제 21개 가격과 전략 점수가 일치하지 않습니다")
        events = [e for e in signal["historyQuarantines"] if e["symbol"] == detail["symbol"]]
        if any(bars[0]["tsMs"] < int(datetime.fromisoformat(e["date"]).replace(tzinfo=timezone.utc).timestamp() * 1000) <= ts for e in events):
            raise ValueError("현재 점수의 가격 창이 제한 대상 사건을 가로지릅니다")
        targets.append({"rank": rank, **{k: detail[k] for k in ("symbol", "name", "close", "return20", "adv20", "annualVol20")},
                        "scoreFirstDate": datetime.fromtimestamp(bars[0]["tsMs"] / 1000, timezone.utc).strftime("%Y-%m-%d"),
                        "scoreFirstClose": bars[0]["close"], "scoreBars": len(bars), "historyQuarantines": events})
    macro = next(m for m in data["macro"] if m["date"] == data["asof"])
    checks = {"volatilityAtLeast30Pct": macro["kospiVol20"] >= .30, "return20Positive": macro["kospiRet20"] > 0,
              "aboveSma20": macro["kospi"] > macro["kospiSma20"]}
    sources = [input_path, signal_path, native_path, old_native, selection_path, previous / "monthly-manifest.json", previous / "audit.json"]
    code = [Path(__file__), Path(__file__).with_name("current-signals.ts"), Path(__file__).with_name("rank-retention-momentum.ts"),
            Path(__file__).with_name("quarter-engine.ts"), Path(__file__).with_name("uncertain-history.ts"),
            Path("tests/unit/current-quarter-signals.test.ts"), Path("pnpm-lock.yaml")]
    result = {"asof": data["asof"], "baseCommit": "b99ed01", "candidate": candidate, "initialCash": signal["initialCash"],
              "observationScope": "신규 현금 계좌의 현재 선정 단계; 기존 계좌 상태·향후 가격·주문·체결은 재현하지 않음",
              "nativeReplayByteIdentical": True, "nativeSelectionAndDiagnosticsIdentical": True,
              "universeCount": len(details), "universeSelectionAsOf": previous_audit["monthlyUniverseAsOf"], "entryChecks": checks,
              "entryConditionsMet": all(checks.values()), "entryMacro": {k: macro[k] for k in ("date", "kospi", "kospiSma20", "kospiRet20", "kospiRet60", "kospiVol20")},
              "ordersAtLatestClose": [], "pendingTargets": observed["pendingTargets"], "targets": targets,
              "historyQuarantineCount": len(signal["historyQuarantines"]), "futureCandlesUsed": False,
              "sourceSha256": {str(p): digest(p) for p in sources}, "codeSha256": {str(p): digest(p) for p in code},
              "limitations": ["현재 신호의 고변동 반등 조건은 별도 대조이며 이 CLI가 장기 계좌 운용을 대신하지 않음",
                              "현재와 유사한 역사 표본 부족", "당일 KRX 원문 대조 미완료", "미확인 기업행위와 거시 당시 발표본의 한계",
                              "현재 선정은 실전 채택이나 3개월 수익을 검증하지 않음"]}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"asof": result["asof"], "entryConditionsMet": result["entryConditionsMet"], "targets": result["pendingTargets"],
                      "nativeReplayByteIdentical": True, "currentSignalsSha256": digest(signal_path)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    audit(args.root, args.output)
