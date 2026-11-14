import {
  runIntradayBacktest,
  type IntradayEngineInput,
} from "../runtime/modules/intraday/domain/engine.js";

process.once("message", (input: IntradayEngineInput) => {
  try {
    const result = runIntradayBacktest(input);
    process.send?.({ result }, () => {
      process.disconnect();
    });
  } catch (error) {
    process.send?.(
      {
        error:
          error instanceof Error ? error.message : "분봉 계산에 실패했습니다.",
      },
      () => {
        process.disconnect();
      },
    );
  }
});
