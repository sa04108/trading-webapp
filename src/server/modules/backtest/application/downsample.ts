export interface XyPoint {
  readonly tsMs: number;
  readonly value: number;
}

/**
 * LTTB (Largest-Triangle-Three-Buckets) 다운샘플링.
 * Recharts(SVG) 모바일 성능을 위해 차트 시리즈를 ~threshold 포인트로 줄인다 (docs/DECISIONS.md D-005).
 * 지표 계산에는 절대 사용하지 않는다 — 표시 전용.
 */
export function downsampleLttb(points: readonly XyPoint[], threshold: number): XyPoint[] {
  if (threshold >= points.length || threshold < 3) return [...points];

  const sampled: XyPoint[] = [];
  const bucketSize = (points.length - 2) / (threshold - 2);

  let previousIndex = 0;
  sampled.push(points[0] as XyPoint);

  for (let bucket = 0; bucket < threshold - 2; bucket += 1) {
    const rangeStart = Math.floor((bucket + 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((bucket + 2) * bucketSize) + 1, points.length);

    // 다음 bucket 의 평균점
    let avgX = 0;
    let avgY = 0;
    const avgCount = rangeEnd - rangeStart || 1;
    for (let i = rangeStart; i < rangeEnd; i += 1) {
      avgX += (points[i] as XyPoint).tsMs;
      avgY += (points[i] as XyPoint).value;
    }
    avgX /= avgCount;
    avgY /= avgCount;

    // 현재 bucket 에서 삼각형 면적 최대 점 선택
    const currentStart = Math.floor(bucket * bucketSize) + 1;
    const currentEnd = Math.floor((bucket + 1) * bucketSize) + 1;
    const previous = points[previousIndex] as XyPoint;

    let maxArea = -1;
    let selectedIndex = currentStart;
    for (let i = currentStart; i < currentEnd; i += 1) {
      const point = points[i] as XyPoint;
      const area = Math.abs(
        (previous.tsMs - avgX) * (point.value - previous.value) -
          (previous.tsMs - point.tsMs) * (avgY - previous.value),
      );
      if (area > maxArea) {
        maxArea = area;
        selectedIndex = i;
      }
    }

    sampled.push(points[selectedIndex] as XyPoint);
    previousIndex = selectedIndex;
  }

  sampled.push(points[points.length - 1] as XyPoint);
  return sampled;
}
