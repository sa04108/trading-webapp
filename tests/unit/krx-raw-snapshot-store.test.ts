import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { krxRawApiSnapshots } from '../../src/server/shared/db/collection-schema.js';
import { SqliteKrxRawSnapshotStore } from '../../src/server/modules/market-data/infrastructure/krx/sqlite-krx-raw-snapshot-store.js';
import { KrxRawSnapshotCorruptError } from '../../src/server/modules/market-data/infrastructure/krx/krx-raw-snapshot-store.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import type { ProviderRequestPolicy } from '../../src/server/shared/provider-request-policy.js';
import type { Logger } from '../../src/server/shared/logger.js';
import { dailyFixture, krxJsonResponse } from '../helpers/krx-fixtures.js';

const key = { namespace: 'https://krx.test', endpoint: '/svc/apis/sto/stk_bydd_trd', basDd: '20260803' };
const handles: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); });
function setup() {
  const handle = openDatabase(':memory:');
  handles.push(handle);
  const store = new SqliteKrxRawSnapshotStore(handle.db);
  const source = (fetchImpl: typeof fetch, configured = true, requestPolicy?: ProviderRequestPolicy) => createKrxHistoricalUniverseSource(
    configured ? { baseUrl: key.namespace, apiKey: 'secret', approvalExpiry: null } : null,
    { now: () => Date.parse('2026-08-04T00:00:00Z') },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    { fetchImpl, sleep: async () => undefined, rawSnapshotStore: store, rawNamespace: key.namespace, ...(requestPolicy ? { requestPolicy } : {}) },
  );
  return { handle, store, source };
}

describe('KRX 원문 재사용', () => {
  it('전체 봉투와 미사용 필드를 보존하고 동시 진입 및 키 없는 재시작에서 재사용한다', async () => {
    const { handle, store, source } = setup();
    const payload = { OutBlock_1: [dailyFixture({ NEW_FIELD: '새 필드' })], meta: { version: 3 } };
    const http = vi.fn(async () => krxJsonResponse(payload));
    const a = source(http), b = source(http);
    await Promise.all([a.fetchDailyTrades('KOSPI', '2026-08-03'), b.fetchDailyTrades('KOSPI', '2026-08-03')]);
    expect(http).toHaveBeenCalledTimes(1);
    const snapshot = store.get(key);
    expect(snapshot?.payload).toEqual(payload);
    const restartedStore = new SqliteKrxRawSnapshotStore(handle.db);
    expect(restartedStore.get(key)).toEqual(snapshot);
    await source(http, false).fetchDailyTrades('KOSPI', '2026-08-03');
    expect(store.get(key)).toEqual(snapshot);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('정상 빈 응답과 파싱 실패 원문도 재호출 없이 재생한다', async () => {
    const { store, source } = setup();
    const http = vi.fn(async () => krxJsonResponse({ OutBlock_1: [] }));
    await source(http).fetchDailyTrades('KOSPI', '2026-08-03');
    await source(http).fetchDailyTrades('KOSPI', '2026-08-03');
    expect(http).toHaveBeenCalledTimes(1);
    store.put({ ...key, basDd: '20260804' }, { OutBlock_1: [{ unexpected: true }] }, 10);
    await expect(source(http).fetchDailyTrades('KOSPI', '2026-08-04')).rejects.toThrow();
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('손상 기록은 미수집과 구분하고 정상 사본으로 복구하며 이력을 보존한다', async () => {
    const { handle, store, source } = setup();
    expect(store.get(key)).toBeNull();
    store.put(key, { OutBlock_1: [] }, 1);
    const first = handle.db.select().from(krxRawApiSnapshots).get()!;
    handle.db.update(krxRawApiSnapshots).set({ payloadJson: '{}' }).where(eq(krxRawApiSnapshots.id, first.id)).run();
    const http = vi.fn(async () => krxJsonResponse({ OutBlock_1: [] }));
    await expect(source(http).fetchDailyTrades('KOSPI', '2026-08-03')).rejects.toBeInstanceOf(KrxRawSnapshotCorruptError);
    expect(http).not.toHaveBeenCalled();
    store.put(key, { OutBlock_1: [] }, 2);
    store.put(key, { OutBlock_1: [] }, 3);
    const rows = handle.db.select().from(krxRawApiSnapshots).all();
    handle.db.update(krxRawApiSnapshots).set({ payloadJson: '{}' }).where(eq(krxRawApiSnapshots.id, rows[2]!.id)).run();
    expect(store.get(key)?.fetchedAtMs).toBe(2);
    expect(handle.db.select().from(krxRawApiSnapshots).all()).toHaveLength(3);
    expect(store.get({ ...key, namespace: 'https://other.test' })).toBeNull();
  });

  it('오류 봉투는 보존하지만 완료로 인증하거나 이전 정정본으로 대체하지 않는다', async () => {
    const { handle, store, source } = setup();
    const complete = vi.fn();
    const authorize = vi.fn(() => ({ fingerprint: 'first', reason: 'FIRST_ACQUISITION', beforeAttempt: vi.fn(), complete }));
    const http = vi.fn(async () => krxJsonResponse({ error: 'quota' }));
    await expect(source(http, true, { authorize }).fetchDailyTrades('KOSPI', '2026-08-03')).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
    expect(handle.db.select().from(krxRawApiSnapshots).all()).toHaveLength(1);
    await expect(source(http).fetchDailyTrades('KOSPI', '2026-08-03')).rejects.toBeInstanceOf(KrxRawSnapshotCorruptError);
    expect(http).toHaveBeenCalledTimes(1);
    store.put(key, { OutBlock_1: [] }, 2);
    store.put(key, { OutBlock_1: [dailyFixture()] }, 3);
    const rows = handle.db.select().from(krxRawApiSnapshots).all();
    handle.db.update(krxRawApiSnapshots).set({ payloadJson: '{}' }).where(eq(krxRawApiSnapshots.id, rows[2]!.id)).run();
    expect(() => store.get(key)).toThrow(KrxRawSnapshotCorruptError);
  });

  it('승인된 손상 키만 수집하고 실제 요청에 permit을 적용한다', async () => {
    const { handle, store, source } = setup();
    store.put(key, { OutBlock_1: [] }, 1);
    handle.db.update(krxRawApiSnapshots).set({ contentHash: 'broken' }).run();
    const beforeAttempt = vi.fn(), complete = vi.fn();
    const authorize = vi.fn(() => ({ fingerprint: 'approval', reason: 'SOURCE_RECOVERY', beforeAttempt, complete }));
    const http = vi.fn(async () => krxJsonResponse({ OutBlock_1: [] }));
    await source(http, true, { authorize }).fetchDailyTrades('KOSPI', '2026-08-03');
    expect(authorize).toHaveBeenCalledWith({ provider: 'KRX', namespace: key.namespace, endpoint: key.endpoint, parameters: { basDd: key.basDd } }, expect.objectContaining({ kind: 'CORRUPT' }));
    expect(beforeAttempt).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
    expect(handle.db.select().from(krxRawApiSnapshots).all()).toHaveLength(2);
  });

  it('새 응답 파싱 실패 뒤에도 저장된 원문으로 실패를 재현한다', async () => {
    const { store, source } = setup();
    const payload = { OutBlock_1: [{ unknown: true }], extra: '보존' };
    const http = vi.fn(async () => krxJsonResponse(payload));
    await expect(source(http).fetchDailyTrades('KOSPI', '2026-08-03')).rejects.toThrow();
    expect(store.get(key)?.payload).toEqual(payload);
    await expect(source(http, false).fetchDailyTrades('KOSPI', '2026-08-03')).rejects.toThrow();
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('기존 수집 날짜의 원문 없는 필수 필드는 최초 수집으로 우회하지 않는다', async () => {
    const { store, source } = setup();
    const http = vi.fn(async () => krxJsonResponse({ OutBlock_1: [] }));
    await expect(source(http).fetchDailyTrades('KOSPI', '2026-08-03', { requireExisting: true })).rejects.toThrow('BLOCKED_SOURCE_REQUIREMENT');
    expect(http).not.toHaveBeenCalled();
    store.put(key, { OutBlock_1: [] }, 1);
    await expect(source(http, false).fetchDailyTrades('KOSPI', '2026-08-03', { requireExisting: true })).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('한 endpoint 성공 후 다음 endpoint 실패를 재개할 때 완료 원문은 다시 받지 않는다', async () => {
    const { source } = setup();
    const http = vi.fn(async (input: Parameters<typeof fetch>[0]) => String(input).includes('stk_bydd_trd')
      ? krxJsonResponse({ OutBlock_1: [] }) : krxJsonResponse({}, 400));
    await source(http).fetchDailyTrades('KOSPI', '2026-08-03');
    await expect(source(http).fetchIssueBaseInfo('KOSPI', '2026-08-03')).rejects.toThrow();
    await source(http).fetchDailyTrades('KOSPI', '2026-08-03');
    expect(http).toHaveBeenCalledTimes(2);
  });
});
