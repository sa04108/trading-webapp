import { cryptoBacktestInputSchema, type CryptoBacktestInput } from "../../../shared/crypto-backtest.js";
import { selectCryptoTarget, executeCryptoSession, runCryptoBacktest } from "./backtest.js";

export interface CryptoStrategy {
  version: string;
  /** 계좌의 파라미터·보유 자산·마지막 처리일을 변환 없이 이어받을 수 있는 이전 버전이다. */
  compatibleFrom: readonly string[];
  acceptsInput(input: CryptoBacktestInput): boolean;
  warmupDays(input: CryptoBacktestInput): number;
  selectTarget: typeof selectCryptoTarget;
  executeSession: typeof executeCryptoSession;
  runBacktest: typeof runCryptoBacktest;
}

export type CryptoStrategyVersions = readonly [CryptoStrategy, ...CryptoStrategy[]];

// 배포한 구현은 보존한다. 새 버전은 별도 구현을 목록 맨 뒤에 등록한다.
export const cryptoStrategyVersions: CryptoStrategyVersions = [
  {
    version: "upbit-turnover-momentum-v1",
    compatibleFrom: [],
    acceptsInput: (input) => cryptoBacktestInputSchema.safeParse(input).success,
    warmupDays: (input) => Math.max(30, input.lookbackDays + 1),
    selectTarget: selectCryptoTarget,
    executeSession: executeCryptoSession,
    runBacktest: runCryptoBacktest,
  },
];

export const latestCryptoStrategy = cryptoStrategyVersions.at(-1)!;
