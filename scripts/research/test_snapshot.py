"""운영 데이터 추출의 읽기 전용 성질과 허용 목록, 불완전 파일 차단을 검증한다."""
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from market_snapshot import TABLES,import_snapshot


class SnapshotTests(unittest.TestCase):
    def test_export_excludes_auth_and_does_not_modify_database(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.sqlite'
            connection=sqlite3.connect(source)
            for table in TABLES: connection.execute(f'CREATE TABLE "{table}" (value TEXT)')
            connection.execute('CREATE TABLE users (secret TEXT)')
            connection.execute("INSERT INTO users VALUES ('SENTINEL_NOT_TO_EXPORT')")
            connection.execute("INSERT INTO facts VALUES ('market-data')")
            connection.commit();connection.close()
            before=hashlib.sha256(source.read_bytes()).hexdigest()
            command=[sys.executable,str(Path(__file__).with_name('market_snapshot.py')),'export',str(source)]
            result=subprocess.run(command,check=True,capture_output=True)
            raw=gzip.decompress(result.stdout)
            self.assertNotIn(b'SENTINEL_NOT_TO_EXPORT',raw)
            self.assertEqual(before,hashlib.sha256(source.read_bytes()).hexdigest())
            archive=Path(directory)/'data.gz';archive.write_bytes(result.stdout)
            target=Path(directory)/'target.sqlite'
            import_snapshot(archive,target)
            connection=sqlite3.connect(target)
            self.assertEqual(connection.execute('SELECT value FROM facts').fetchone()[0],'market-data')
            self.assertEqual(connection.execute("SELECT count(*) FROM sqlite_master WHERE name='users'").fetchone()[0],0)
            connection.close()

    def test_incomplete_export_does_not_publish_database(self):
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'data.gz'
            archive.write_bytes(gzip.compress((json.dumps({'format':1,'tables':TABLES})+'\n').encode()))
            target=Path(directory)/'target.sqlite'
            with self.assertRaises(ValueError): import_snapshot(archive,target)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix('.sqlite.partial').exists())


if __name__=='__main__':unittest.main()
