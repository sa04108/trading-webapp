/**
 * 알림 링크가 가리키는 대상이 아직 있는지 물어볼 API 경로. 확인할 것이 없으면 null.
 *
 * 목록·설정 같은 상시 화면은 사라지지 않으니 묻지 않는다. 백테스트 상세만 사용자가
 * 결과를 지울 수 있어, 눌러 이동하기 전에 존재를 확인한다.
 */
export function targetApiPath(link: string | null): string | null {
  if (!link) return null;
  const match = /^\/backtests\/([^/?#]+)$/.exec(link);
  if (!match) return null;
  const id = match[1];
  // /backtests/new 는 상세가 아니라 마법사다 — 잡 id 로 물으면 늘 404 가 돌아온다
  if (id === 'new') return null;
  return `/backtests/${id}`;
}
