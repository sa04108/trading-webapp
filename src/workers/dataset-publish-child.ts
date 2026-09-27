import { datasetPublishInputSchema } from "../shared/dataset-publish-protocol.js";
import { publishDataset } from "./dataset-publisher.js";

process.once("message", (input: unknown) => {
  void Promise.resolve().then(() => publishDataset(datasetPublishInputSchema.parse(input), {
    onProgress: (activity) => process.send?.({ type: "progress", activity }),
    onDiagnostic: (diagnostic) => process.send?.({ type: "diagnostic", diagnostic }),
  })).then((manifest) => {
    process.send?.(manifest, () => process.disconnect());
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
});

process.once("disconnect", () => {
  if (process.exitCode === undefined) process.exitCode = 0;
});
