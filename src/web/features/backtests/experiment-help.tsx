export const VALIDATION_MODE_HELP = {
  HOLDOUT: "기간을 IS와 OOS로 한 번 나눕니다. 고정 설정을 각각 실행하거나 IS에서 후보를 최적화해 OOS에서 평가하고 고정 설정 OOS와 비교할 수 있습니다.",
  WALK_FORWARD: "학습과 평가 구간을 앞으로 이동하며 각 회차를 독립적으로 실행합니다. 선택적으로 IS에서 후보를 최적화하고 고정 설정 OOS와 비교할 수 있습니다.",
} as const;
