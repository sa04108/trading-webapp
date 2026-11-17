import { InfoHint } from "@/components/info-hint";
import { rateSeriesLabel, type SharpeBasis } from "@shared/schemas/risk-free-rate";

const rateLabel = (value: number | null) => value === null ? "—" : `${value.toFixed(4)}%`;

export function SharpeBasisInfo({ basis }: { basis?: SharpeBasis }) {
  return (
    <section className="space-y-1 border-t pt-3" aria-label="Sharpe 계산 기준">
      <h3 className="flex items-center gap-1 font-medium">
        Sharpe 계산 기준
        <InfoHint label="Sharpe 계산 기준 설명">
          <p>날짜별 무위험수익률 Rf는 해당 연 이율을 100과 252로 나누어 계산합니다. Sharpe는 평균(일 수익률 − Rf)을 일 수익률의 표본 표준편차로 나눈 뒤 √252를 곱합니다.</p>
          <p>이전 결과는 무위험수익률 0%를 가정하여 계산했으며 다시 계산하지 않습니다.</p>
        </InfoHint>
      </h3>
      {basis ? (
        <>
          <p>{rateSeriesLabel(basis.series)} 날짜별 변경금리 적용</p>
          <p className="text-muted-foreground">금리 이력 수록 기간: {basis.coveredFrom} ~ {basis.coveredTo}</p>
          <p className="text-muted-foreground">결과 기간 중 적용 금리: 연 {rateLabel(basis.minAnnualRatePct)} ~ {rateLabel(basis.maxAnnualRatePct)} · 평균 {rateLabel(basis.averageAnnualRatePct)} ({(basis.observationCount - basis.missingRateDays).toLocaleString("ko-KR")}일 적용)</p>
          <p className="text-muted-foreground">출처: 사용자 제공 금리표{basis.source === "USER_CSV_AND_ECOS" ? " 및 ECOS 갱신" : ""}</p>
          {basis.missingRateDays > 0 ? <p>금리 자료가 없어 {basis.missingRateDays.toLocaleString("ko-KR")}일을 계산하지 못했습니다. 금리표 갱신이 필요합니다.</p> : null}
        </>
      ) : <p className="text-muted-foreground">이전 결과: 무위험수익률 0% 가정</p>}
    </section>
  );
}
