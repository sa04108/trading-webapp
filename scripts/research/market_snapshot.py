"""운영 DB의 허용된 시장 데이터만 읽기 전용으로 추출하고 로컬 DB로 복원한다."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import time


TABLES = (
    "symbol_master_coverage",
    "symbol_master_versions",
    "symbol_master_trading_days",
    "krx_non_trading_coverage",
    "krx_non_trading_days",
    "daily_selection_metric_coverage",
    "fred_benchmark_coverage",
    "benchmark_daily_values",
    "facts",
    "daily_selection_metrics",
    "krx_daily_bars",
)


def export_snapshot(database):
    """한 읽기 트랜잭션에서 시장 행을 압축 스트림으로 내보낸다."""
    connection = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA cache_size=-4096")
    deadline = time.monotonic() + 600
    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    connection.execute("BEGIN")
    with gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", compresslevel=1, mtime=0) as output:
        def emit(record):
            output.write((json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode())

        emit({"format": 1, "exported_at": datetime.now(timezone.utc).isoformat(), "tables": TABLES})
        for table in TABLES:
            schema = [(row[1], row[2]) for row in connection.execute(f'PRAGMA table_info("{table}")')]
            if not schema:
                raise ValueError(f"필수 테이블이 없습니다: {table}")
            emit({"table": table, "columns": schema})
            cursor = connection.execute(f'SELECT * FROM "{table}"')
            count = 0
            while rows := cursor.fetchmany(2000):
                emit({"rows": rows})
                count += len(rows)
            emit({"end": table, "count": count})
            print(f"{table}: {count}", file=sys.stderr, flush=True)
        emit({"complete": True})
    connection.rollback()
    connection.close()


def import_snapshot(source, destination):
    """전체 스트림과 건수를 검증한 뒤에만 로컬 snapshot 파일명을 확정한다."""
    destination = Path(destination)
    partial = destination.with_suffix(destination.suffix + ".partial")
    if destination.exists() or partial.exists():
        raise ValueError("기존 snapshot을 덮어쓰지 않습니다")
    connection = sqlite3.connect(partial)
    metadata = {}
    counts = {}
    active = None
    complete = False
    try:
        with gzip.open(source, "rt") as stream:
            for line in stream:
                record = json.loads(line)
                if "format" in record:
                    if metadata or record["format"] != 1 or tuple(record["tables"]) != TABLES:
                        raise ValueError("지원하지 않는 snapshot 형식입니다")
                    metadata = record
                elif "table" in record:
                    active = record["table"]
                    if active not in TABLES or active in counts:
                        raise ValueError("허용되지 않거나 중복된 테이블입니다")
                    columns = record["columns"]
                    for name, kind in columns:
                        if not re.fullmatch(r"[a-z_]+", name) or kind.upper() not in ("TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC"):
                            raise ValueError("지원하지 않는 열입니다")
                    ddl = ",".join(f'"{name}" {kind}' for name, kind in columns)
                    connection.execute(f'CREATE TABLE "{active}" ({ddl})')
                    statement = f'INSERT INTO "{active}" VALUES ({",".join("?" for _ in columns)})'
                    counts[active] = 0
                elif "rows" in record:
                    if active is None:
                        raise ValueError("테이블 밖의 데이터입니다")
                    connection.executemany(statement, record["rows"])
                    counts[active] += len(record["rows"])
                elif "end" in record:
                    if active != record["end"] or counts[active] != record["count"]:
                        raise ValueError("추출 건수가 일치하지 않습니다")
                    connection.commit()
                    print(f"{active}: {counts[active]}", file=sys.stderr, flush=True)
                    active = None
                elif record.get("complete"):
                    complete = True
                else:
                    raise ValueError("알 수 없는 snapshot 레코드입니다")
        if not complete or active is not None or set(counts) != set(TABLES):
            raise ValueError("불완전한 snapshot입니다")
        connection.close()
        partial.rename(destination)
        with open(source, "rb") as source_stream:
            digest = hashlib.file_digest(source_stream, "sha256").hexdigest()
        metadata.update({"counts": counts, "compressed_sha256": digest})
        destination.with_suffix(".manifest.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    except BaseException:
        connection.close()
        partial.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("database")
    import_parser = subparsers.add_parser("import")
    import_parser.add_argument("source")
    import_parser.add_argument("destination")
    arguments = parser.parse_args()
    if arguments.command == "export":
        export_snapshot(arguments.database)
    else:
        import_snapshot(arguments.source, arguments.destination)
