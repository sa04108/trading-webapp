type IntradaySession = Readonly<{
  openMinute: number;
  openTime: string;
  reason?: string;
  evidence?: string;
}>;

export const INTRADAY_CLOSE_MINUTE = 15 * 60 + 20;
const regularSession: IntradaySession = { openMinute: 9 * 60, openTime: "09:00" };

// 공지로 확인한 날짜만 예외로 둔다. 첫 수신 봉이나 빈 응답으로 개장 시간을 추정하지 않는다.
const confirmedSessions: Readonly<Record<string, IntradaySession>> = {
  "2026-01-02": {
    openMinute: 10 * 60,
    openTime: "10:00",
    reason: "연초 개장식",
    evidence: "https://www.hanwhawm.com/main/bbs/noticeViewPop.cmd?mode=center&nn_id=67985",
  },
};

/** 수집·차트·전략에서 같은 날짜별 개장 기준을 사용한다. 종료는 모형의 15:20을 유지한다. */
export function intradaySession(date: string): IntradaySession {
  return confirmedSessions[date] ?? regularSession;
}
