import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "../shared/db/database.js";
import { createUniverseRuntime } from "./universe-runtime.js";
import { encodeUniverseResolution } from "../modules/backtest/application/universe-resolution-wire.js";
import { universeComputeInputSchema, type UniverseComputeReply } from "../../shared/universe-compute.js";

interface Initialization { dataPath: string; collectionVersion: string }

function createRunner(initialization: Initialization) {
  const database = openDatabase(":memory:", { dataPath: initialization.dataPath, dataReadonly: true });
  database.sqlite.pragma("query_only = ON");
  const { resolver } = createUniverseRuntime(database, initialization.collectionVersion);
  return {
    close: () => database.close(),
    async run(raw: unknown): Promise<UniverseComputeReply> {
      try {
        const input = universeComputeInputSchema.parse(raw);
        const result = await resolver.resolveRebalanceDates(input.rule, input.period, input.rebalanceDates,
          { excludedSymbols: new Set(input.excludedSymbols) });
        return { status: "COMPLETED", resultJson: encodeUniverseResolution(result) };
      } catch (error) {
        return { status: "FAILED", error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
      }
    },
  };
}

if (!isMainThread) {
  const runner = createRunner(workerData as Initialization);
  parentPort!.on("message", (input: unknown) => { void runner.run(input).then((reply) => parentPort!.postMessage(reply)); });
  parentPort!.on("close", () => runner.close());
} else {
  // 원격 보조 작업은 별도 프로세스다. 소유 연결이 사라지면 남은 계산도 종료한다.
  process.on("disconnect", () => process.exit(1));
  process.once("message", (message: Initialization & { input: unknown }) => {
    void (async () => {
      const runner = createRunner(message);
      try {
        const reply = await runner.run(message.input);
        if (process.connected) await new Promise<void>((resolve) => process.send!(reply, () => resolve()));
      } finally {
        runner.close();
        if (process.connected) process.disconnect();
      }
    })().catch((error: unknown) => {
      if (process.connected) process.send!({ status: "FAILED",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }, () => process.disconnect());
      process.exitCode = 1;
    });
  });
}
