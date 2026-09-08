"""고정한 과거 날짜의 KRX 원문을 기존 인증 환경에서 읽기 전용으로 수집한다."""

import argparse
from datetime import date, datetime, timedelta, timezone
import gzip
import json
from pathlib import Path
import sqlite3
import sys
import time
import urllib.request


def validate_days(days):
    if not isinstance(days, list) or not 1 <= len(days) <= 350 or days != sorted(set(days)):
        raise ValueError("과거 날짜는 중복 없이 정렬된 1~350개 목록이어야 합니다")
    for day in days:
        if not isinstance(day, str) or len(day) != 8 or not day.isdigit():
            raise ValueError("날짜 형식은 YYYYMMDD입니다")
        parsed = date.fromisoformat(f"{day[:4]}-{day[4:6]}-{day[6:]}")
        if not date(2010, 1, 4) <= parsed <= date(2014, 12, 31):
            raise ValueError("별도 과거 진단의 날짜 범위를 벗어났습니다")
    return days


def fetch(env_path, days, kinds):
    days = validate_days(days)
    environment = {}
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            if key in ("KRX_API_KEY", "KRX_BASE_URL", "KRX_APPROVAL_EXPIRY", "DATABASE_PATH"):
                environment[key] = value.strip().strip('"').strip("'")
    today = (datetime.now(timezone.utc) + timedelta(hours=9)).date().isoformat()
    if environment.get("KRX_APPROVAL_EXPIRY") and today > environment["KRX_APPROVAL_EXPIRY"]:
        raise ValueError("기존 KRX 승인 기간이 지났습니다")
    base = environment.get("KRX_BASE_URL", "https://data-dbg.krx.co.kr")
    if base != "https://data-dbg.krx.co.kr":
        raise ValueError("확인된 KRX 공식 주소만 사용합니다")
    database = sqlite3.connect(Path(environment["DATABASE_PATH"]).resolve().as_uri() + "?mode=ro", uri=True)
    database.execute("PRAGMA query_only=ON")
    calls = {}
    with database, gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", mtime=0) as stream:
        def emit(row):
            stream.write((json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
            stream.flush()
        emit({"asof": "2026-09-08", "recordedAt": datetime.now(timezone.utc).isoformat(), "dates": days, "kinds": kinds})
        for market, prefix in (("KOSPI", "stk"), ("KOSDAQ", "ksq")):
            for kind in kinds:
                endpoint = f"/svc/apis/sto/{prefix}_" + ("bydd_trd" if kind == "daily" else "isu_base_info")
                for day in days:
                    usage = database.execute("SELECT calls_used, quota_exceeded_at_ms FROM external_api_daily_usage WHERE api='KRX' AND quota_scope=? AND usage_date_kst=?", (endpoint, today)).fetchone()
                    if usage and (usage[0] + calls.get(endpoint, 0) >= 9000 or usage[1] is not None):
                        emit({"complete": False, "reason": "운영 사용량 또는 한도 중단 기록", "calls": calls})
                        return False
                    url = base + endpoint + "?basDd=" + day
                    request = urllib.request.Request(url, headers={"AUTH_KEY": environment["KRX_API_KEY"]})
                    calls[endpoint] = calls.get(endpoint, 0) + 1
                    try:
                        with urllib.request.urlopen(request, timeout=25) as response:
                            payload = json.load(response)
                    except Exception as error:
                        # 예외 문자열에 인증 정보가 섞일 수 있어 종류만 남긴다.
                        emit({"market": market, "kind": kind, "date": day, "errorType": type(error).__name__, "calls": calls, "complete": False})
                        return False
                    emit({"market": market, "kind": kind, "date": day, "url": url, "response": payload})
                    rows = payload.get("OutBlock_1", [])
                    if not rows:
                        emit({"complete": False, "reason": "필요 날짜의 원문 행 없음", "calls": calls})
                        return False
                    if sum(calls.values()) % 25 == 0 or len(days) <= 2:
                        print(json.dumps({"market": market, "kind": kind, "date": day, "rows": len(rows), "calls": sum(calls.values())}), file=sys.stderr, flush=True)
                    time.sleep(.25)
        emit({"complete": True, "calls": calls})
    database.close()
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--days-json", required=True)
    parser.add_argument("--kinds", choices=("daily", "basic"), nargs="+", default=["daily"])
    args = parser.parse_args()
    if not fetch(args.env_file, json.loads(args.days_json), args.kinds):
        raise SystemExit(1)
