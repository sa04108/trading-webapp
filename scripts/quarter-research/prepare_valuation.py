"""DART 순이익·자본총계를 동일 회계기준과 실제 공개시점을 보존해 정규화한다."""

import argparse
from collections import defaultdict
from datetime import date, timedelta
import gzip
import hashlib
import json
from pathlib import Path
import re

from prepare_quarterly import amount, normalize, REPORT_QUARTER


def normalize_equity(rows, mapping):
    grouped, excluded = defaultdict(list), []
    for row in rows:
        if row.get("account_nm", "").replace(" ", "") != "자본총계":
            continue
        code, basis = row.get("stock_code"), row.get("fs_div")
        year, quarter = int(row["bsns_year"]), REPORT_QUARTER[row["reprt_code"]]
        key = (code, year, quarter, basis)
        dates = re.findall(r"\d{4}\.\d{2}\.\d{2}", row.get("thstrm_dt", ""))
        end = f'{year}.{quarter * 3:02d}.{30 if quarter in (2, 3) else 31:02d}'
        if (mapping.get(code) != row.get("corp_code") or row.get("sj_div") != "BS"
                or basis not in ("CFS", "OFS") or row.get("currency") != "KRW"
                or not dates or dates[-1] != end or not re.fullmatch(r"\d{14}", row.get("rcept_no", ""))):
            excluded.append({"key": key, "reason": "자본 식별·회계기준·통화·달력 분기·접수번호 불일치"})
            continue
        value = amount(row.get("thstrm_amount"))
        if value is None:
            excluded.append({"key": key, "reason": "자본총계 금액 누락"})
            continue
        receipt = row["rcept_no"]
        asof = date.fromisoformat(f'{receipt[:4]}-{receipt[4:6]}-{receipt[6:8]}')
        grouped[key].append({"symbol": code, "periodKey": f'{year}Q{quarter}', "ordinal": year * 4 + quarter - 1,
                             "basis": basis, "value": value, "asof": asof.isoformat(),
                             "available": (asof + timedelta(days=1)).isoformat(), "receipts": [receipt],
                             "method": "reported-quarter-end-balance", "field": "TOTAL_EQUITY"})
    result = []
    for key, group in sorted(grouped.items()):
        if len({r["value"] for r in group}) != 1:
            excluded.append({"key": key, "reason": "같은 기말 자본총계의 값 충돌"})
            continue
        result.append(max(group, key=lambda r: r["receipts"][0]))
    return result, excluded


def prepare(raw_path, mapping_path, destination):
    raw = raw_path.read_bytes()
    blocks = [json.loads(line) for line in gzip.decompress(raw).decode().splitlines()]
    if blocks[-1].get("complete") is not True:
        raise ValueError("원문 수집이 완료되지 않았습니다")
    rows = []
    for block in blocks:
        if "response" not in block:
            continue
        if block["response"].get("status") not in ("000", "013"):
            raise ValueError("실패한 원응답이 있습니다")
        for row in block["response"].get("list", []):
            if (row.get("bsns_year") != str(block["year"]) or row.get("reprt_code") != block["report"]
                    or row.get("corp_code") not in block["requested"]):
                raise ValueError("요청과 응답 행이 일치하지 않습니다")
            rows.append(row)
    mapping = json.loads(mapping_path.read_text())["mapping"]
    income, income_excluded = normalize([r for r in rows if r.get("sj_div") == "IS"], mapping,
                                         ("당기순이익", "당기순이익(손실)", "분기순이익", "분기순이익(손실)"))
    income = [{**r, "field": "NET_INCOME"} for r in income]
    equity, equity_excluded = normalize_equity(rows, mapping)
    result = {"asof": "2026-09-08", "sourceSha256": hashlib.sha256(raw).hexdigest(), "collection": blocks[-1],
              "observations": income + equity, "excluded": {"NET_INCOME": income_excluded, "TOTAL_EQUITY": equity_excluded},
              "note": "최신 API 빈티지이며 공시 다음 날부터 사용한다. 연결·별도 및 분기 누적액을 섞지 않는다."}
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"income": len(income), "equity": len(equity),
                      "excludedIncome": len(income_excluded), "excludedEquity": len(equity_excluded)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("raw", "mapping", "destination"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    prepare(args.raw, args.mapping, args.destination)
