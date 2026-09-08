"""직전 거래일까지의 실제 KRX 거래대금과 시가총액으로 현재 종목군을 정한다."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np


def selection_days(calendar, asof, universe_asof=None):
    """신호일보다 이전인 실제 거래일까지만 종목군 선정 자료에 사용한다."""
    if universe_asof is not None and (universe_asof >= asof or universe_asof not in calendar):
        raise ValueError("종목군 선정 기준일은 현재 신호일보다 이전인 실제 거래일이어야 합니다")
    days = [d for d in calendar if d < asof and (universe_asof is None or d <= universe_asof)][-20:]
    if len(days) != 20:
        raise ValueError("직전일까지의 실제 20거래일이 필요합니다")
    return days


def select(manifest_path, panel_path, calendar_path, recent_paths, destination, size=200, universe_asof=None):
    data = json.loads(manifest_path.read_text())
    calendar = json.loads(gzip.decompress(calendar_path.read_bytes()))["days"]
    days = selection_days(calendar, data["asof"], universe_asof)
    panel = {k: np.load(panel_path / f"{k}.npy", mmap_mode="r")
             for k in ("days", "codes", "value", "open", "high", "low", "close", "volume", "common", "active", "nontrading")}
    di = {str(d): i for i, d in enumerate(panel["days"])}
    ci = {str(c): j for j, c in enumerate(panel["codes"])}
    recent = {}
    for path in recent_paths:
        for block in (json.loads(line) for line in gzip.decompress(path.read_bytes()).decode().splitlines()):
            for row in block.get("response", {}).get("OutBlock_1", []):
                raw_date = row["BAS_DD"]
                if raw_date != block["date"]:
                    raise ValueError("KRX 요청일과 응답일이 다릅니다")
                day = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
                key = (day, row["ISU_CD"])
                if key in recent and recent[key] != row:
                    raise ValueError("중복 KRX 원문 값이 다릅니다")
                recent[key] = row
    current = {r["symbol"]: r for r in data["selected"]}
    known_index = int(np.searchsorted(panel["days"], days[-1], side="right")) - 1
    if known_index < 0:
        raise ValueError("종목군 기준일 이전의 보통주·상장 상태 자료가 없습니다")
    candidates = {}
    # 저장 자료의 날짜를 선택하면 그 날짜의 시가총액과 분류를 사용한다.
    if days[-1] in di:
        panel["cap"] = np.load(panel_path / "cap.npy", mmap_mode="r")
        i = di[days[-1]]
        for code, j in ci.items():
            cap = panel["cap"][i, j]
            if panel["common"][i, j] and panel["active"][i, j] and panel["volume"][i, j] > 0 and np.isfinite(cap) and cap > 0:
                candidates[code] = int(cap)
    for (day, code), row in recent.items():
        if day != days[-1] or code not in ci:
            continue
        j = ci[code]
        if panel["common"][known_index, j] and panel["active"][known_index, j] and int(row["ACC_TRDVOL"]) > 0:
            cap = int(row["MKTCAP"])
            if code in candidates and cap != candidates[code]:
                raise ValueError(f"저장 자료와 추가 원문의 시가총액이 다릅니다: {code} {day}")
            if cap > 0:
                candidates[code] = cap
        else:
            candidates.pop(code, None)
    accepted, audit = [], []
    mapping = {"open": "TDD_OPNPRC", "high": "TDD_HGPRC", "low": "TDD_LWPRC", "close": "TDD_CLSPRC", "volume": "ACC_TRDVOL"}
    for code, cap in sorted(candidates.items(), key=lambda r: (-r[1], r[0])):
        if code not in current:
            raise ValueError(f"현재 카탈로그·시세를 더 수집해야 하는 순위 종목: {code}")
        values, overlap = [], 0
        for day in days:
            if (day, code) in recent:
                row = recent[(day, code)]
                quote = {k: int(row[v]) for k, v in mapping.items()}
                value = int(row["ACC_TRDVAL"])
                known_nontrading = all(quote[k] == 0 for k in ("open", "high", "low", "volume"))
            elif day in di:
                i, j = di[day], ci[code]
                quote = {k: float(panel[k][i, j]) for k in mapping}
                value = float(panel["value"][i, j])
                known_nontrading = bool(panel["nontrading"][i, j]) and value == 0
            else:
                raise ValueError(f"실제 KRX 거래대금 날짜 누락: {code} {day}")
            if not np.isfinite(value) or value < 0:
                raise ValueError(f"실제 거래대금이 유효하지 않습니다: {code} {day}")
            raw_day = day.replace("-", "")
            table = data["tables"][code].get(raw_day)
            if table is not None:
                if any(quote[k] != table[k] for k in mapping):
                    raise ValueError(f"KRX 거래대금과 Npay OHLCV 대조 실패: {code} {day}")
                overlap += 1
            elif raw_day in data.get("nontradingTables", {}).get(code, {}) and not known_nontrading:
                raise ValueError(f"비거래 원문과 KRX 거래량이 다릅니다: {code} {day}")
            values.append(value)
        average = sum(values) / 20
        liquid = average >= 1_000_000_000
        audit.append({"symbol": code, "marketCap": cap, "adv20": average, "liquid": liquid, "overlapOhlcv": overlap})
        if liquid:
            accepted.append({**current[code], "selectionMarketCap": str(cap), "selectionAdv20": average, "universeAsOf": days[-1]})
        if len(accepted) == size:
            break
    if len(accepted) != size:
        raise ValueError("검증한 종목군 크기가 부족합니다")
    selected = {r["symbol"] for r in accepted}
    data["selected"] = accepted
    data["tables"] = {k: v for k, v in data["tables"].items() if k in selected}
    data["nontradingTables"] = {k: v for k, v in data.get("nontradingTables", {}).items() if k in selected}
    sources = [manifest_path, calendar_path, *recent_paths, *(panel_path / f"{k}.npy" for k in panel)]
    hashes = {}
    for path in sources:
        with path.open("rb") as stream:
            hashes[str(path)] = hashlib.file_digest(stream, "sha256").hexdigest()
    data["liquidityAudit"] = {"days": days, "stocks": audit, "sourceSha256": hashes,
                              "rule": "직전 거래일까지 실제 KRX 20일 평균 거래대금 10억원 이상·거래량 양수인 보통주를 직전일 시가총액 순으로 선정한다."}
    if universe_asof is not None:
        data["liquidityAudit"]["selectionAsOfOverride"] = universe_asof
    destination.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
    print(json.dumps({"selected": len(accepted), "examined": len(audit), "universeAsOf": days[-1], "excluded": [r["symbol"] for r in audit if not r["liquid"]]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("manifest", "panel", "calendar", "destination"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--recent", type=Path, nargs="+", required=True)
    parser.add_argument("--size", type=int, default=200)
    parser.add_argument("--universe-asof", help="신호일보다 이전인 실제 거래일로 종목군 선정 자료 시점을 고정")
    args = parser.parse_args()
    if args.size < 1:
        raise SystemExit("종목 수는 양수여야 합니다")
    select(args.manifest, args.panel, args.calendar, args.recent, args.destination, args.size, args.universe_asof)
