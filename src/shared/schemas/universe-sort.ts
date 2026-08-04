/**
 * 과거 유니버스 정렬 기준 — 웹과 서버가 공유한다. zod 를 쓰지 않는 이유는
 * historical-universe.ts 와 같다(웹 번들에 zod 를 끌고 들어오지 않는다).
 *
 * PER·PBR·EV/EBITDA 는 여기 없다 — 필요한 원자료(순이익·자본총계·감가상각)를
 * 아직 수집하지 않는다. 데이터가 생길 때 이 유니온을 확장한다.
 */
export type UniverseSortKey = 'MKTCAP' | 'OPERATING_INCOME';

export const UNIVERSE_SORT_KEYS: readonly UniverseSortKey[] = ['MKTCAP', 'OPERATING_INCOME'];

export const UNIVERSE_SORT_LABELS: Record<UniverseSortKey, string> = {
  MKTCAP: '시가총액',
  OPERATING_INCOME: '영업이익',
};
