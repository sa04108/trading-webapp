import { latestCryptoStrategy } from "../modules/crypto/strategy-versions.js";
import type { CryptoBacktestInput } from "../../shared/crypto-backtest.js";
import type { UniverseComputeReply } from "../../shared/universe-compute.js";

process.on("disconnect", () => process.exit());
process.once("message", (message: { input: CryptoBacktestInput; barsJson: string }) => {
  let reply: UniverseComputeReply;
  try {
    const result = latestCryptoStrategy.runBacktest(message.input, JSON.parse(message.barsJson));
    reply = { status: "COMPLETED", resultJson: JSON.stringify(result) };
  } catch (error) {
    reply = {
      status: "FAILED",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    };
  }
  if (process.connected) process.send!(reply, () => process.disconnect());
});
