import { describe, expect, it } from 'vitest';
import { targetApiPath } from '../../src/web/features/notifications/link-target.js';

describe('targetApiPath', () => {
  it('백테스트 상세 링크는 같은 id 의 API 경로를 돌려준다', () => {
    expect(targetApiPath('/backtests/job_123')).toBe('/backtests/job_123');
  });

  it('링크가 없으면 확인할 것도 없다', () => {
    expect(targetApiPath(null)).toBeNull();
  });

  it('상시 화면은 확인하지 않는다', () => {
    expect(targetApiPath('/datasets')).toBeNull();
    expect(targetApiPath('/backtests')).toBeNull();
  });

  it('마법사는 잡 상세가 아니다 — 물으면 늘 404 가 온다', () => {
    expect(targetApiPath('/backtests/new')).toBeNull();
    expect(targetApiPath('/backtests/new?from=job_1')).toBeNull();
  });

  it('상세 아래 하위 경로·쿼리는 대상으로 보지 않는다', () => {
    expect(targetApiPath('/backtests/job_1/trades')).toBeNull();
    expect(targetApiPath('/backtests/job_1?tab=trades')).toBeNull();
  });
});
