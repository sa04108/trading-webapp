// Recharts 항목의 기본 검정 글씨가 부모의 테마 색을 덮어쓰므로 각 영역에 명시한다.
export const chartTooltipProps = {
  contentStyle: {
    backgroundColor: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--popover-foreground)",
    fontSize: 12,
  },
  labelStyle: { color: "var(--popover-foreground)" },
  itemStyle: { color: "var(--popover-foreground)" },
} as const;
