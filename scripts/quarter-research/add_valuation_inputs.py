"""같은 날짜의 확정 KRX 시가총액과 분기 재무를 연구 입력에 보강한다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def add(stock, observations, panel, destination):
    data = json.loads(gzip.decompress(stock.read_bytes()))
    financial = json.loads(observations.read_text())
    if financial["collection"].get("complete") is not True:
        raise ValueError("분기 원문이 완성되지 않았습니다")
    if data["metadata"].get("usage"):
        raise ValueError("과거 KRX 시가총액 결합에는 과거 평가 입력이 필요합니다")
    symbols = sorted({r["symbol"] for r in data["candles"]})
    codes = np.load(panel / "codes.npy")
    days = np.load(panel / "days.npy")
    cap = np.load(panel / "cap.npy", mmap_mode="r")
    ci, di = {str(c): i for i, c in enumerate(codes)}, {str(d): i for i, d in enumerate(days)}
    missing_days = [day for day in data["days"] if day not in di]
    if missing_days:
        # 결손일 이후를 잘라 완결된 연속 기간만 평가하며 다른 날의 시가총액을 채우지 않는다.
        first_gap = min(missing_days)
        stop = data["days"].index(first_gap)
        if stop == 0:
            raise ValueError("입력 시작일부터 KRX 자료가 없습니다")
        data["days"] = data["days"][:stop]
        data["macro"] = data["macro"][:stop]
        data["members"] = data["members"][:stop]
        data["asof"] = data["days"][-1]
        cutoff = int(datetime.fromisoformat(data["asof"]).replace(tzinfo=timezone.utc).timestamp() * 1000)
        data["candles"] = [r for r in data["candles"] if r["tsMs"] <= cutoff]
        data["nontrading"] = [r for r in data["nontrading"] if r[0] <= cutoff]
    points = []
    for day in data["days"]:
        values = {}
        for symbol in symbols:
            value = float(cap[di[day], ci[symbol]])
            if np.isfinite(value) and value > 0:
                if not value.is_integer() or value > 2 ** 53 - 1:
                    raise ValueError("시가총액 정수 정밀도를 보존할 수 없습니다")
                values[symbol] = str(int(value))
        points.append({"tsMs": int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp() * 1000),
                       "asof": day, "values": values})
    data["capitalizations"] = points
    data["valuationObservations"] = [r for r in financial["observations"] if r["symbol"] in symbols]
    data["metadata"]["valuationSources"] = {"inputSha256": digest(stock), "financialSha256": digest(observations),
                                             "panelSha256": {name: digest(panel / f'{name}.npy') for name in ("codes", "days", "cap")},
                                             "capTiming": "same signal day final close; subsequent sessions execute orders",
                                             "missingPanelDates": missing_days, "continuousEnd": data["asof"]}
    with gzip.GzipFile(filename=str(destination), mode="wb", mtime=0) as stream:
        stream.write(json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
    print(json.dumps({"days": len(points), "symbols": len(symbols), "financialObservations": len(data["valuationObservations"]), "asof": data["asof"], "missingPanelDates": missing_days}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("stock", "observations", "panel", "destination"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    add(args.stock, args.observations, args.panel, args.destination)
