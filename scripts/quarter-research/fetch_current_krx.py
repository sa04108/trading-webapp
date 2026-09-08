"""기존 앱 인증 환경에서 빠진 최신 KRX 거래대금 원문을 제한된 횟수로 조회한다."""

import argparse
from datetime import datetime, timedelta, timezone
import gzip
import json
from pathlib import Path
import sqlite3
import sys
import time
import urllib.request


def collection_days(through, requested=None):
    """현재 스냅샷의 허용 날짜 중 아직 필요한 날짜만 중복 없이 조회한다."""
    allowed = ("20260818", "20260819", "20260820", "20260824", "20260904", "20260907", "20260908")
    eligible = [d for d in allowed if d <= through]
    if requested is None:
        return eligible
    if (not isinstance(requested, list) or not requested or any(not isinstance(d, str) or d not in eligible for d in requested)
            or requested != sorted(set(requested))):
        raise ValueError("조회 날짜는 허용 스냅샷 범위에서 중복 없이 정렬한 목록이어야 합니다")
    return requested


def fetch(env_path, markets=("KOSPI", "KOSDAQ"), through="20260908", days=None):
    days = collection_days(through, days)
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
    with gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", mtime=0) as stream:
        def emit(row):
            stream.write((json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
            stream.flush()
        emit({"asof": "2026-09-08", "recordedAt": datetime.now(timezone.utc).isoformat(), "dates": days})
        calls = 0
        for market, endpoint in (("KOSPI", "stk_bydd_trd"), ("KOSDAQ", "ksq_bydd_trd")):
            path = "/svc/apis/sto/" + endpoint
            if market not in markets:
                continue
            for day in days:
                if day > through:
                    continue
                usage = database.execute("SELECT calls_used, quota_exceeded_at_ms FROM external_api_daily_usage WHERE api='KRX' AND quota_scope=? AND usage_date_kst=?", (path, today)).fetchone()
                if usage and (usage[0] + calls >= 9000 or usage[1] is not None):
                    raise ValueError("운영 조회 한도 또는 중단 기록 때문에 연구 조회를 멈춥니다")
                url = base + path + "?basDd=" + day
                request = urllib.request.Request(url, headers={"AUTH_KEY": environment["KRX_API_KEY"]})
                calls += 1
                try:
                    with urllib.request.urlopen(request, timeout=25) as response:
                        payload = json.load(response)
                except Exception as error:
                    # 인증키가 있을 수 있는 예외 메시지 대신 종류만 남긴다.
                    emit({"market": market, "date": day, "errorType": type(error).__name__, "calls": calls})
                    return False
                emit({"market": market, "date": day, "url": url, "response": payload})
                rows = payload.get("OutBlock_1", [])
                if not rows:
                    emit({"complete": False, "calls": calls, "reason": "필요한 거래일의 시세 행이 없습니다"})
                    return False
                print(json.dumps({"market": market, "date": day, "rows": len(rows)}), file=sys.stderr, flush=True)
                time.sleep(.25)
        emit({"complete": True, "calls": calls})
    database.close()
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--markets", choices=("KOSPI", "KOSDAQ"), nargs="+", default=["KOSPI", "KOSDAQ"])
    parser.add_argument("--through", choices=("20260907", "20260908"), default="20260908")
    parser.add_argument("--days-json", help="허용 날짜 중 새로 조회할 YYYYMMDD 목록")
    args = parser.parse_args()
    if not fetch(args.env_file, args.markets, args.through, json.loads(args.days_json) if args.days_json else None):
        raise SystemExit(1)
