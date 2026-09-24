#!/usr/bin/env python3
"""앱 이벤트 루프와 분리해 호스트·cgroup 압력을 한 줄 JSON으로 기록한다."""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


MAX_READ_BYTES = 1_048_576
MAX_DISKS = 64
SYSTEMCTL_TIMEOUT_SECONDS = 2
SERVICE_PATTERN = re.compile(r"^[A-Za-z0-9_.@-]{1,128}$")


def read_text(path: Path) -> str:
    """예상치 못한 큰 가상 파일을 journald sampler가 읽지 않게 제한한다."""
    with path.open("rb") as handle:
        data = handle.read(MAX_READ_BYTES + 1)
    if len(data) > MAX_READ_BYTES:
        raise ValueError("읽기 상한을 넘었습니다")
    return data.decode("utf-8", errors="replace")


def read_fields(path: Path, errors: list[str]) -> dict[str, int]:
    try:
        result: dict[str, int] = {}
        for line in read_text(path).splitlines():
            fields = line.replace(":", "").split()
            if len(fields) >= 2 and fields[1].lstrip("-").isdigit():
                result[fields[0]] = int(fields[1])
        return result
    except (OSError, ValueError) as error:
        errors.append(f"{path}: {type(error).__name__}")
        return {}


def read_cpu(errors: list[str]) -> dict[str, int]:
    try:
        line = next(
            row for row in read_text(Path("/proc/stat")).splitlines()
            if row.startswith("cpu ")
        )
        values = [int(value) for value in line.split()[1:]]
        return {
            # guest와 guest_nice는 user와 nice에도 포함되므로 다시 더하지 않는다.
            "total_ticks": sum(values[:8]),
            "idle_ticks": values[3] if len(values) > 3 else 0,
            "iowait_ticks": values[4] if len(values) > 4 else 0,
            "steal_ticks": values[7] if len(values) > 7 else 0,
        }
    except (OSError, StopIteration, ValueError) as error:
        errors.append(f"/proc/stat: {type(error).__name__}")
        return {}


def read_meminfo(errors: list[str]) -> dict[str, int]:
    fields = read_fields(Path("/proc/meminfo"), errors)
    return {
        "mem_available_bytes": fields.get("MemAvailable", 0) * 1024,
        "swap_free_bytes": fields.get("SwapFree", 0) * 1024,
        "swap_total_bytes": fields.get("SwapTotal", 0) * 1024,
    }


def read_psi(resource: str, errors: list[str]) -> dict[str, dict[str, float | int]]:
    path = Path("/proc/pressure") / resource
    try:
        result: dict[str, dict[str, float | int]] = {}
        for line in read_text(path).splitlines():
            fields = dict(item.split("=", 1) for item in line.split()[1:])
            result[line.split()[0]] = {
                "avg10": float(fields.get("avg10", "0")),
                "avg60": float(fields.get("avg60", "0")),
                "avg300": float(fields.get("avg300", "0")),
                "total_us": int(fields.get("total", "0")),
            }
        return result
    except (OSError, ValueError) as error:
        errors.append(f"{path}: {type(error).__name__}")
        return {}


def read_disks(errors: list[str]) -> dict[str, dict[str, int]]:
    try:
        result: dict[str, dict[str, int]] = {}
        for line in read_text(Path("/proc/diskstats")).splitlines():
            fields = line.split()
            if len(fields) < 14 or fields[2].startswith(("loop", "ram")):
                continue
            name = fields[2]
            values = [int(value) for value in fields[3:]]
            result[name] = {
                "read_ios": values[0],
                "read_bytes": values[2] * 512,
                "read_time_ms": values[3],
                "write_ios": values[4],
                "write_bytes": values[6] * 512,
                "write_time_ms": values[7],
                "io_ms": values[9],
                "weighted_io_ms": values[10],
            }
            if len(result) >= MAX_DISKS:
                break
        return result
    except (OSError, ValueError) as error:
        errors.append(f"/proc/diskstats: {type(error).__name__}")
        return {}


def control_group(service: str, errors: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["systemctl", "show", "--value", "--property", "ControlGroup", service],
            check=False,
            capture_output=True,
            text=True,
            timeout=SYSTEMCTL_TIMEOUT_SECONDS,
        )
        value = completed.stdout.strip()
        if completed.returncode != 0 or not value.startswith("/") or ".." in value.split("/"):
            errors.append("systemctl ControlGroup unavailable")
            return None
        return value
    except (OSError, subprocess.TimeoutExpired) as error:
        errors.append(f"systemctl: {type(error).__name__}")
        return None


def read_cgroup(service: str, errors: list[str]) -> dict[str, Any] | None:
    group = control_group(service, errors)
    if group is None:
        return None
    root = Path("/sys/fs/cgroup") / group.lstrip("/")
    result: dict[str, Any] = {"path": group}
    for name in ("memory.current", "memory.high", "memory.max"):
        try:
            value = read_text(root / name).strip()
            result[name.replace(".", "_")] = int(value) if value.isdigit() else value
        except (OSError, ValueError) as error:
            errors.append(f"{name}: {type(error).__name__}")
    for name in ("memory.events", "cpu.stat", "io.stat"):
        try:
            result[name.replace(".", "_")] = read_text(root / name).strip().splitlines()
        except (OSError, ValueError) as error:
            errors.append(f"{name}: {type(error).__name__}")
    return result


def read_state(path: Path, errors: list[str]) -> dict[str, Any]:
    try:
        return json.loads(read_text(path)) if path.exists() else {}
    except (OSError, ValueError, json.JSONDecodeError) as error:
        errors.append(f"state: {type(error).__name__}")
        return {}


def write_state(path: Path, state: dict[str, Any], errors: list[str]) -> None:
    try:
        path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError as error:
        errors.append(f"state write: {type(error).__name__}")


def delta(current: int, previous: Any) -> int | None:
    return current - previous if isinstance(previous, int) and current >= previous else None


def change(current: int, previous: Any) -> int | None:
    """감소도 의미가 있는 게이지 값의 이전 표본 대비 차이를 계산한다."""
    return current - previous if isinstance(previous, int) else None


def main() -> int:
    parser = argparse.ArgumentParser(description="Quant 호스트 지연 sampler")
    parser.add_argument("--service", default="quant-platform.service")
    parser.add_argument("--state-path", default="/run/quant-platform-diagnostics/host-sample.json")
    args = parser.parse_args()
    if not SERVICE_PATTERN.fullmatch(args.service):
        raise SystemExit("service 이름 형식이 올바르지 않습니다")

    errors: list[str] = []
    state_path = Path(args.state_path)
    previous = read_state(state_path, errors)
    cpu = read_cpu(errors)
    memory = read_meminfo(errors)
    vmstat = read_fields(Path("/proc/vmstat"), errors)
    disks = read_disks(errors)
    psi = {name: read_psi(name, errors) for name in ("cpu", "io", "memory")}
    timestamp_ms = time.time_ns() // 1_000_000
    monotonic_ms = time.monotonic_ns() // 1_000_000
    window_ms = delta(monotonic_ms, previous.get("monotonic_ms"))
    previous_cpu = previous.get("cpu", {})
    previous_memory = previous.get("memory", {})
    total_delta = delta(cpu.get("total_ticks", 0), previous_cpu.get("total_ticks"))
    idle_delta = delta(cpu.get("idle_ticks", 0), previous_cpu.get("idle_ticks"))
    iowait_delta = delta(cpu.get("iowait_ticks", 0), previous_cpu.get("iowait_ticks"))
    steal_delta = delta(cpu.get("steal_ticks", 0), previous_cpu.get("steal_ticks"))
    cpu_util_pct = None
    iowait_pct = None
    steal_pct = None
    if total_delta and idle_delta is not None and iowait_delta is not None and steal_delta is not None:
        # iowait은 CPU가 명령을 실행한 시간이 아니므로 별도 비율로 제외한다.
        cpu_util_pct = round(
            100 * max(0, total_delta - idle_delta - iowait_delta - steal_delta) / total_delta, 3
        )
        iowait_pct = round(100 * iowait_delta / total_delta, 3)
        steal_pct = round(100 * steal_delta / total_delta, 3)

    previous_disks = previous.get("disks", {})
    disk_delta = {
        name: {key: delta(value, previous_disks.get(name, {}).get(key)) for key, value in values.items()}
        for name, values in disks.items()
    }
    output = {
        "event": "quant.host_sample",
        "timestamp_ms": timestamp_ms,
        "measurement_window_ms": window_ms,
        "host": {
            "cpu_util_pct": cpu_util_pct,
            "iowait_pct": iowait_pct,
            "steal_pct": steal_pct,
            "mem": memory,
            "memory_delta_bytes": {
                "available": change(
                    memory["mem_available_bytes"], previous_memory.get("mem_available_bytes")
                ),
                "swap_free": change(
                    memory["swap_free_bytes"], previous_memory.get("swap_free_bytes")
                ),
            },
            "swap_delta_pages": {
                "in": delta(vmstat.get("pswpin", 0), previous.get("vmstat", {}).get("pswpin")),
                "out": delta(vmstat.get("pswpout", 0), previous.get("vmstat", {}).get("pswpout")),
            },
            "disk_counters": disks,
            "disk_delta": disk_delta,
            "psi": psi,
        },
        "cgroup": read_cgroup(args.service, errors),
        "errors": errors[:8],
    }
    write_state(
        state_path,
        {"monotonic_ms": monotonic_ms, "cpu": cpu, "memory": memory, "vmstat": vmstat, "disks": disks},
        errors,
    )
    output["errors"] = errors[:8]
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
