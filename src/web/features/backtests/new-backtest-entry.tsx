import { Navigate, useLocation } from 'react-router';
import { stepSlug } from './wizard-steps';

/**
 * slug 없는 `/backtests/new` 진입을 첫 단계로 잇는다 — 북마크와 알림 링크가 끊기지
 * 않게 한다.
 *
 * `replace` 인 이유: push 로 하면 뒤로가기가 이 리다이렉트 원점으로 돌아와 곧바로 다시
 * 튕기는 루프가 된다.
 *
 * `search` 를 그대로 넘기는 이유: `?from=<jobId>` 복제 맥락이 여기서 사라지면 위저드가
 * 원본 설정을 채울 근거를 잃는다.
 */
export function NewBacktestEntry() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: `/backtests/new/${stepSlug(0)}`, search }} replace />;
}
