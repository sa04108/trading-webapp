export const MAX_BACKTEST_SUMMARY_WARNINGS = 1_000;
export const MAX_BACKTEST_SUMMARY_WARNING_LENGTH = 4_000;

const SHORTENED_SUFFIX = "… (전체 경고 원문에서 확인)";
const SUMMARY_HEAD_COUNT = Math.floor((MAX_BACKTEST_SUMMARY_WARNINGS - 1) / 2);
const SUMMARY_TAIL_COUNT = MAX_BACKTEST_SUMMARY_WARNINGS - 1 - SUMMARY_HEAD_COUNT;

function shortenWarning(warning: string): string {
  if (warning.length <= MAX_BACKTEST_SUMMARY_WARNING_LENGTH) return warning;
  let end = MAX_BACKTEST_SUMMARY_WARNING_LENGTH - SHORTENED_SUFFIX.length;
  // UTF-16 쌍의 중간을 자르면 다운로드 원문과 다른 깨진 문자가 표시된다.
  if (/^[\uD800-\uDBFF]$/.test(warning[end - 1]!)) end -= 1;
  return warning.slice(0, end) + SHORTENED_SUFFIX;
}

/** 원문은 별도 보존하고, 앞쪽 준비 경고와 뒤쪽 실행 경고를 제한 안에 표시한다. */
export function summarizeBacktestWarnings(warnings: Iterable<string>): string[] {
  const head: string[] = [];
  const tail: string[] = [];
  let count = 0;
  let shortened = false;
  for (const warning of warnings) {
    const summary = shortenWarning(warning);
    shortened ||= summary !== warning;
    if (count < MAX_BACKTEST_SUMMARY_WARNINGS) head.push(summary);
    tail[count % SUMMARY_TAIL_COUNT] = summary;
    count += 1;
  }
  if (count <= MAX_BACKTEST_SUMMARY_WARNINGS && !shortened) return head;
  const summaries = count < MAX_BACKTEST_SUMMARY_WARNINGS
    ? head
    : [
        ...head.slice(0, SUMMARY_HEAD_COUNT),
        ...tail.slice(count % SUMMARY_TAIL_COUNT),
        ...tail.slice(0, count % SUMMARY_TAIL_COUNT),
      ];
  return [
    `경고 ${count}개 중 ${summaries.length}개를 표시합니다. 생략되거나 줄여 표시된 내용은 전체 경고 원문에서 확인할 수 있습니다.`,
    ...summaries,
  ];
}
