"""같은 회계기준의 누적 이익을 대조하고 공개 시점을 보존한 단독 분기를 만든다."""

import argparse
from collections import defaultdict
from datetime import date, timedelta
import gzip
import hashlib
import json
from pathlib import Path
import re

REPORT_QUARTER = {"11013": 1, "11012": 2, "11014": 3, "11011": 4}


def amount(value):
    if not isinstance(value, str):
        return None
    text = value.replace(",", "").strip()
    if not re.fullmatch(r"-?\d+", text):
        return None
    result = int(text)
    return result if abs(result) <= 2 ** 53 - 1 else None


def normalize(rows, mapping):
    grouped = defaultdict(list)
    excluded = []
    for row in rows:
        if row.get("account_nm", "").replace(" ", "") not in ("영업이익", "영업이익(손실)"):
            continue
        code, basis = row.get("stock_code"), row.get("fs_div")
        key = (code, int(row["bsns_year"]), REPORT_QUARTER[row["reprt_code"]], basis)
        if mapping.get(code) != row.get("corp_code") or basis not in ("CFS", "OFS") or row.get("currency") != "KRW":
            excluded.append({"key": key, "reason": "회사 식별·회계기준·통화 불일치"})
            continue
        dates = re.findall(r"\d{4}\.\d{2}\.\d{2}", row.get("thstrm_dt", ""))
        end = f'{key[1]}.{key[2] * 3:02d}.{30 if key[2] in (2, 3) else 31:02d}'
        if not dates or dates[-1] != end or not re.fullmatch(r"\d{14}", row.get("rcept_no", "")):
            excluded.append({"key": key, "reason": "달력 분기·접수번호 검증 실패"})
            continue
        receipt_date = date.fromisoformat(f'{row["rcept_no"][:4]}-{row["rcept_no"][4:6]}-{row["rcept_no"][6:8]}')
        direct = amount(row.get("thstrm_amount"))
        cumulative = direct if key[2] == 4 else amount(row.get("thstrm_add_amount"))
        if direct is None or cumulative is None:
            excluded.append({"key": key, "reason": "당기액 또는 누적액 누락"})
            continue
        grouped[key].append({"direct": direct, "cumulative": cumulative, "receipt": row["rcept_no"],
                             "asof": receipt_date.isoformat()})
    reports = {}
    for key, values in grouped.items():
        signatures = {(r["direct"], r["cumulative"]) for r in values}
        if len(signatures) != 1:
            excluded.append({"key": key, "reason": "같은 보고서 계정의 값 충돌"})
            continue
        reports[key] = max(values, key=lambda r: r["receipt"])
    observations = []
    for (code, year, quarter, basis), current in sorted(reports.items()):
        key = (code, year, quarter, basis)
        previous = reports.get((code, year, quarter - 1, basis)) if quarter > 1 else None
        if quarter > 1 and previous is None:
            excluded.append({"key": key, "reason": "같은 연도·기준의 직전 누적액 누락"})
            continue
        delta = current["cumulative"] - (previous["cumulative"] if previous else 0)
        # 백만원 단위 보고서의 반올림 차이만 허용하며 큰 차이는 이익으로 해석하지 않는다.
        if quarter < 4 and abs(delta - current["direct"]) > 1_000_000:
            excluded.append({"key": key, "reason": "당기액과 누적 차분 불일치", "direct": current["direct"],
                             "derived": delta, "currentReceipt": current["receipt"],
                             "previousReceipt": previous["receipt"] if previous else None})
            continue
        asof = max(current["asof"], previous["asof"] if previous else current["asof"])
        available = (date.fromisoformat(asof) + timedelta(days=1)).isoformat()
        observations.append({"symbol": code, "periodKey": f"{year}Q{quarter}", "ordinal": year * 4 + quarter - 1,
                             "basis": basis, "value": delta, "asof": asof, "available": available,
                             "receipts": [current["receipt"]] + ([previous["receipt"]] if previous else []),
                             "method": "annual-minus-nine-month" if quarter == 4 else "cumulative-difference-verified"})
    return observations, excluded


def prepare(raw_path, mapping_path, destination):
    raw = raw_path.read_bytes()
    blocks = [json.loads(line) for line in gzip.decompress(raw).decode().splitlines()]
    if blocks[-1].get("complete") is not True:
        raise ValueError("분기 원문 수집이 완료되지 않았습니다")
    rows = []
    for block in blocks:
        if "response" not in block:
            continue
        if block["response"].get("status") not in ("000", "013"):
            raise ValueError("분기 원문에 실패 응답이 있습니다")
        for row in block["response"].get("list", []):
            if (row.get("bsns_year") != str(block["year"]) or row.get("reprt_code") != block["report"]
                    or row.get("corp_code") not in block["requested"]):
                raise ValueError("요청한 연도·보고서·회사와 응답 행이 일치하지 않습니다")
            rows.append(row)
    mapping = json.loads(mapping_path.read_text())["mapping"]
    observations, excluded = normalize(rows, mapping)
    result = {"asof": "2026-09-08", "sourceSha256": hashlib.sha256(raw).hexdigest(),
              "source": blocks[0], "collection": blocks[-1], "observations": observations, "excluded": excluded,
              "note": "최신 API 빈티지다. 최초 발표값을 복원하지 않으며 두 누적 보고서의 접수일 다음 날부터 파생 분기를 사용한다."}
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"observations": len(observations), "excluded": len(excluded),
                      "reasons": {reason: sum(r["reason"] == reason for r in excluded) for reason in sorted({r["reason"] for r in excluded})}}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("raw", "mapping", "destination"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    prepare(args.raw, args.mapping, args.destination)
