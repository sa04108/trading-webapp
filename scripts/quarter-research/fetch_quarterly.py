"""기존 인증 환경에서 DART 분기 주요계정을 읽고 원응답만 압축 출력한다."""

import argparse
from datetime import datetime, timezone, timedelta
import gzip
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import urllib.parse
import urllib.request


def fetch(codes, api_key, usage_database, max_calls=100, already_used=4):
    """운영 원장을 읽기 전용으로 확인하고 조회 한도에 여유를 둔다."""
    if not codes or len(set(codes)) != len(codes) or any(not isinstance(c, str) or len(c) != 8 or not c.isdigit() for c in codes):
        raise ValueError("중복 없는 DART 회사코드 목록이 필요합니다")
    database = sqlite3.connect(Path(usage_database).resolve().as_uri() + "?mode=ro", uri=True)
    calls = 0
    complete = True
    with gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", compresslevel=1, mtime=0) as stream:
        def emit(value):
            stream.write((json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
            stream.flush()
        emit({"format": 1, "requestedCodes": codes, "recordedAt": datetime.now(timezone.utc).isoformat(),
              "asof": "2026-09-08", "endpoint": "https://opendart.fss.or.kr/api/fnlttMultiAcnt.json"})
        for year in range(2015, 2027):
            reports = ("11013", "11012", "11014", "11011") if year < 2026 else ("11013", "11012")
            for report in reports:
                for offset in range(0, len(codes), 100):
                    day = (datetime.now(timezone.utc) + timedelta(hours=9)).date().isoformat()
                    row = database.execute("SELECT calls_used FROM external_api_daily_usage WHERE api='DART' AND quota_scope='daily' AND usage_date_kst=?", (day,)).fetchone()
                    used = row[0] if row else 0
                    if calls >= max_calls or used + calls + already_used >= 16000:
                        complete = False
                        break
                    batch = codes[offset:offset + 100]
                    query = urllib.parse.urlencode({"crtfc_key": api_key, "corp_code": ",".join(batch), "bsns_year": year, "reprt_code": report})
                    calls += 1
                    try:
                        with urllib.request.urlopen("https://opendart.fss.or.kr/api/fnlttMultiAcnt.json?" + query, timeout=20) as response:
                            result = json.load(response)
                    except Exception as error:
                        # 예외 메시지와 URL에는 인증키가 포함될 수 있어 종류만 기록한다.
                        result = {"status": "TRANSPORT_ERROR", "errorType": type(error).__name__}
                    emit({"year": year, "report": report, "batch": offset // 100, "requested": batch, "response": result})
                    print(json.dumps({"year": year, "report": report, "batch": offset // 100, "status": result.get("status"), "calls": calls}), file=sys.stderr, flush=True)
                    if result.get("status") not in ("000", "013"):
                        complete = False
                        break
                    time.sleep(.2)
                if not complete:
                    break
            if not complete:
                break
        emit({"complete": complete, "calls": calls, "priorProbeCalls": already_used})
    database.close()
    return complete


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codes-json", required=True)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--usage-database")
    args = parser.parse_args()
    environment = dict(os.environ)
    if args.env_file:
        # 기존 앱 환경 안에서 인증을 사용하며 키 자체는 출력하거나 전송하지 않는다.
        for line in args.env_file.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                if key in ("DART_API_KEY", "DATABASE_PATH"):
                    environment[key] = value.strip().strip('"').strip("'")
    success = fetch(json.loads(args.codes_json), environment["DART_API_KEY"], args.usage_database or environment["DATABASE_PATH"])
    if not success:
        raise SystemExit(1)
