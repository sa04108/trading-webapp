"""추가 역사 구간에 필요한 공개 FRED 원문을 별도 파일로 보존한다."""

import argparse
from datetime import datetime, timezone
import hashlib
import gzip
import sys
import urllib.parse
from pathlib import Path
import json
import urllib.request


def fetch(destination):
    destination.mkdir(parents=True, exist_ok=True)
    records = []
    for code in ("DCOILBRENTEU", "DCOILWTICO", "DEXKOUS", "DFF", "DGS10"):
        path = destination / f"fred-{code}.csv"
        url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={code}&cosd=2010-01-01&coed=2012-03-22"
        if not path.exists():
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=40) as response:
                raw = response.read()
            if not raw.startswith(f"observation_date,{code}".encode()):
                raise ValueError("FRED 원문 헤더 불일치")
            with path.open("xb") as stream:
                stream.write(raw)
        raw = path.read_bytes()
        records.append({"file": path.name, "url": url, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        print(json.dumps(records[-1]), flush=True)
    (destination / "fred-manifest.json").write_text(json.dumps({"recordedAt": datetime.now(timezone.utc).isoformat(),
        "period": ["2010-01-01", "2012-03-22"], "sources": records}, ensure_ascii=False, indent=2) + "\n")


def fetch_api(env_path):
    environment = {}
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            if key in ("FRED_API_KEY", "FRED_BASE_URL"):
                environment[key] = value.strip().strip('"').strip("'")
    if not environment.get("FRED_API_KEY"):
        raise ValueError("기존 FRED 인증 설정이 없습니다")
    base = environment.get("FRED_BASE_URL", "https://api.stlouisfed.org")
    if base != "https://api.stlouisfed.org":
        raise ValueError("공식 FRED 주소만 사용합니다")
    with gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", mtime=0) as stream:
        def emit(row):
            stream.write((json.dumps(row, separators=(",", ":")) + "\n").encode())
            stream.flush()
        emit({"recordedAt": datetime.now(timezone.utc).isoformat(), "period": ["2010-01-01", "2012-03-22"]})
        for code in ("DCOILBRENTEU", "DCOILWTICO", "DEXKOUS", "DFF", "DGS10"):
            public_query = urllib.parse.urlencode({"series_id": code, "file_type": "json", "observation_start": "2010-01-01", "observation_end": "2012-03-22"})
            public_url = base + "/fred/series/observations?" + public_query
            request = urllib.request.Request(public_url + "&api_key=" + urllib.parse.quote(environment["FRED_API_KEY"]))
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    payload = json.load(response)
            except Exception as error:
                emit({"series": code, "complete": False, "errorType": type(error).__name__})
                return False
            observations = payload.get("observations")
            if not isinstance(observations, list) or not observations:
                emit({"series": code, "complete": False, "reason": "관측 원문 없음"})
                return False
            # 인증 관련 필드가 출력으로 넘어가지 않도록 관측과 공개 메타데이터만 보존한다.
            kept = {k: payload[k] for k in ("realtime_start", "realtime_end", "observation_start", "observation_end", "count", "offset", "limit", "observations") if k in payload}
            emit({"series": code, "url": public_url, "response": kept})
            print(json.dumps({"series": code, "observations": len(observations)}), file=sys.stderr, flush=True)
        emit({"complete": True, "calls": 5})
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, nargs="?")
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    if args.env_file:
        if not fetch_api(args.env_file):
            raise SystemExit(1)
    elif args.destination:
        fetch(args.destination)
    else:
        parser.error("출력 폴더 또는 기존 인증 환경 경로가 필요합니다")
