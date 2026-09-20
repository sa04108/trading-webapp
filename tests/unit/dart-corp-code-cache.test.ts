import Database from 'better-sqlite3';
import { SqliteDartCorpCodeSnapshotStore } from '../../src/server/modules/facts/infrastructure/dart/sqlite-dart-corp-code-snapshot-store.js';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  createDartCorpCodeCache,
  extractSingleFileFromZip,
  parseCorpCodeXml,
} from '../../src/server/modules/facts/infrastructure/dart/dart-corp-code-cache.js';

/** 단일 엔트리 ZIP 을 손으로 만든다 (local file header + deflate + central directory 없음) */
function makeZip(name: string, content: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const raw = Buffer.from(content, 'utf8');
  const compressed = deflateRawSync(raw);

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(8, 8); // method: deflate
  header.writeUInt16LE(0, 10); // mod time
  header.writeUInt16LE(0, 12); // mod date
  header.writeUInt32LE(0, 14); // crc32 (검증하지 않는다)
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28); // extra field length

  return Buffer.concat([header, nameBytes, compressed]);
}

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list>
    <corp_code>00126380</corp_code>
    <corp_name>삼성전자</corp_name>
    <stock_code>005930</stock_code>
    <modify_date>20250401</modify_date>
  </list>
  <list>
    <corp_code>00164779</corp_code>
    <corp_name>SK하이닉스</corp_name>
    <stock_code>000660</stock_code>
    <modify_date>20250401</modify_date>
  </list>
  <list>
    <corp_code>00999999</corp_code>
    <corp_name>비상장회사</corp_name>
    <stock_code> </stock_code>
    <modify_date>20250401</modify_date>
  </list>
</result>`;

describe('extractSingleFileFromZip', () => {
  it('deflate 로 압축된 단일 엔트리를 푼다', () => {
    const unzipped = extractSingleFileFromZip(makeZip('CORPCODE.xml', XML));
    expect(unzipped.toString('utf8')).toBe(XML);
  });

  it('무압축(stored) 엔트리도 푼다', () => {
    const raw = Buffer.from('hello', 'utf8');
    const nameBytes = Buffer.from('a.txt', 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(0, 8); // method: stored
    header.writeUInt32LE(raw.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const zip = Buffer.concat([header, nameBytes, raw]);
    expect(extractSingleFileFromZip(zip).toString('utf8')).toBe('hello');
  });

  it('ZIP 시그니처가 아니면 던진다 — DART 가 XML 에러를 그대로 줄 때가 있다', () => {
    const notZip = Buffer.from('<result><status>020</status></result>', 'utf8');
    expect(() => extractSingleFileFromZip(notZip)).toThrow(/ZIP/);
  });
});

describe('parseCorpCodeXml', () => {
  it('stock_code → corp_code 맵을 만든다', () => {
    const map = parseCorpCodeXml(XML);
    expect(map.get('005930')).toBe('00126380');
    expect(map.get('000660')).toBe('00164779');
  });

  it('상장코드가 빈 회사는 넣지 않는다', () => {
    const map = parseCorpCodeXml(XML);
    expect(map.size).toBe(2);
  });

  it('빈 XML 은 빈 맵', () => {
    expect(parseCorpCodeXml('<result></result>').size).toBe(0);
  });
});

describe('createDartCorpCodeCache', () => {
  it('여러 번 조회해도 한 번만 내려받는다', async () => {
    const fetchZip = vi.fn(async () => makeZip('CORPCODE.xml', XML));
    const cache = createDartCorpCodeCache(fetchZip);

    expect(await cache.resolve('005930')).toBe('00126380');
    expect(await cache.resolve('000660')).toBe('00164779');
    expect(fetchZip).toHaveBeenCalledTimes(1);
  });

  it('cache miss의 실제 다운로드에만 beforeRequest를 한 번 호출한다', async () => {
    const fetchZip = vi.fn(async () => makeZip('CORPCODE.xml', XML));
    const cache = createDartCorpCodeCache(fetchZip);
    const beforeRequest = vi.fn();

    expect(await cache.resolve('005930', beforeRequest)).toBe('00126380');
    expect(await cache.resolve('000660', beforeRequest)).toBe('00164779');

    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(fetchZip).toHaveBeenCalledTimes(1);
  });

  it('beforeRequest가 거절한 다운로드는 캐시하지 않고 다음 호출에서 다시 예약한다', async () => {
    const fetchZip = vi.fn(async () => makeZip('CORPCODE.xml', XML));
    const cache = createDartCorpCodeCache(fetchZip);
    let reservations = 0;
    const beforeRequest = (): void => {
      reservations += 1;
      if (reservations === 1) throw new Error('quota blocked');
    };

    await expect(cache.resolve('005930', beforeRequest)).rejects.toThrow('quota blocked');
    expect(fetchZip).not.toHaveBeenCalled();

    expect(await cache.resolve('005930', beforeRequest)).toBe('00126380');
    expect(reservations).toBe(2);
    expect(fetchZip).toHaveBeenCalledTimes(1);
  });

  it('동시 호출도 한 번만 내려받는다', async () => {
    const fetchZip = vi.fn(async () => makeZip('CORPCODE.xml', XML));
    const cache = createDartCorpCodeCache(fetchZip);

    const [a, b] = await Promise.all([cache.resolve('005930'), cache.resolve('000660')]);
    expect(a).toBe('00126380');
    expect(b).toBe('00164779');
    expect(fetchZip).toHaveBeenCalledTimes(1);
  });

  it('매핑에 없는 종목코드는 null', async () => {
    const cache = createDartCorpCodeCache(async () => makeZip('CORPCODE.xml', XML));
    expect(await cache.resolve('999999')).toBeNull();
  });

  it('다운로드가 실패하면 다음 호출에서 다시 시도한다 — 실패를 캐시하지 않는다', async () => {
    let attempt = 0;
    const fetchZip = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('네트워크 오류');
      return makeZip('CORPCODE.xml', XML);
    });
    const cache = createDartCorpCodeCache(fetchZip);

    await expect(cache.resolve('005930')).rejects.toThrow(/네트워크 오류/);
    expect(await cache.resolve('005930')).toBe('00126380');
    expect(fetchZip).toHaveBeenCalledTimes(2);
  });
});


describe('고유번호 영속 재사용', () => {
  it('재시작 후 동일 namespace는 원문을 재사용하고 다른 공급자는 분리한다', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE dart_corp_code_snapshot(namespace TEXT PRIMARY KEY, xml TEXT NOT NULL, content_hash TEXT NOT NULL, fetched_at_ms INTEGER NOT NULL); CREATE TABLE dart_raw_api_snapshot_history(id INTEGER PRIMARY KEY, snapshot_json TEXT NOT NULL, archived_at_ms INTEGER NOT NULL)');
    try {
      const fetchZip = vi.fn(async () => makeZip('CORPCODE.xml', XML));
      const store = new SqliteDartCorpCodeSnapshotStore(db, 'dart.test');
      expect(await createDartCorpCodeCache(fetchZip, store, () => 123).resolve('005930')).toBe('00126380');
      expect(await createDartCorpCodeCache(fetchZip, new SqliteDartCorpCodeSnapshotStore(db, 'dart.test')).resolve('005930')).toBe('00126380');
      expect(fetchZip).toHaveBeenCalledTimes(1);
      expect(store.get()?.fetchedAtMs).toBe(123);
      expect(new SqliteDartCorpCodeSnapshotStore(db, 'other.test').get()).toBeNull();
      db.prepare('UPDATE dart_corp_code_snapshot SET xml = ?').run('변조');
      await expect(createDartCorpCodeCache(fetchZip, store).resolve('005930')).rejects.toThrow(/HASH_MISMATCH/);
      expect(fetchZip).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it('동일 종목의 서로 다른 회사 정체성은 임의로 선택하지 않는다', () => {
    expect(() => parseCorpCodeXml(XML.replace('</result>', '<list><stock_code>005930</stock_code><corp_code>99999999</corp_code></list></result>'))).toThrow(/IDENTITY_MISMATCH/);
  });
});

it('영속 매핑에 없는 신규 종목만 한 번 갱신하고 변경된 기존 법인은 재시작 뒤에도 차단한다', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE dart_corp_code_snapshot(namespace TEXT PRIMARY KEY, xml TEXT NOT NULL, content_hash TEXT NOT NULL, fetched_at_ms INTEGER NOT NULL); CREATE TABLE dart_raw_api_snapshot_history(id INTEGER PRIMARY KEY, snapshot_json TEXT NOT NULL, archived_at_ms INTEGER NOT NULL)');
  try {
    const changed: string[] = [];
    const store = new SqliteDartCorpCodeSnapshotStore(db,'dart.test',(symbol)=>{changed.push(symbol);});
    store.put(XML,1);
    const next = XML.replace('00126380','00999991').replace('</result>', '<list><stock_code>123456</stock_code><corp_code>00999992</corp_code></list></result>');
    const fetchZip = vi.fn(async () => makeZip('CORPCODE.xml',next));
    const cache = createDartCorpCodeCache(fetchZip,store);
    expect(await cache.resolve('000660')).toBe('00164779');
    expect(fetchZip).not.toHaveBeenCalled();
    expect(await cache.resolve('123456')).toBe('00999992');
    expect(fetchZip).toHaveBeenCalledExactlyOnceWith('123456');
    expect(changed).toEqual(['005930']);
    await expect(cache.resolve('005930')).rejects.toThrow(/IDENTITY_MISMATCH/);
    const restarted = createDartCorpCodeCache(fetchZip,new SqliteDartCorpCodeSnapshotStore(db,'dart.test'));
    expect(await restarted.resolve('123456')).toBe('00999992');
    await expect(restarted.resolve('005930')).rejects.toThrow(/IDENTITY_MISMATCH/);
    expect(fetchZip).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});
