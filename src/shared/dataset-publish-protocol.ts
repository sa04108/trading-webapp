import { z } from "zod";

// 서버 게시 자식의 IPC 전용 계약이며 외부 agent 프로토콜에는 포함하지 않는다.
export const datasetPublishActivitySchema = z.enum([
  "PUBLISHING_COPY", "PUBLISHING_VERIFY", "PUBLISHING_HASH", "PUBLISHING_COMMIT",
]);
export type DatasetPublishActivity = z.infer<typeof datasetPublishActivitySchema>;

export const datasetPublishInputSchema = z.object({
  sourcePath: z.string().min(1),
  directory: z.string().min(1),
  version: z.number().int().positive(),
  collectionVersion: z.string().regex(/^[a-f0-9]{64}$/),
  copyMethod: z.enum(["backup", "vacuum"]).optional(),
  cacheKiB: z.number().int().min(2048).max(65536).optional(),
  mmapBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type DatasetPublishInput = z.infer<typeof datasetPublishInputSchema>;

export const datasetPublishDiagnosticSchema = z.object({
  event: z.literal("diagnostic.stage.finished"),
  stage: z.enum([
    "dataset_publish.source_tables", "dataset_publish.copy", "dataset_publish.journal_mode",
    "dataset_publish.snapshot_tables", "dataset_publish.quick_check", "dataset_publish.identity",
    "dataset_publish.hash", "dataset_publish.sync_snapshot", "dataset_publish.commit", "dataset_publish.total",
  ]),
  outcome: z.enum(["COMPLETED", "FAILED"]),
  elapsedMs: z.number().finite().nonnegative(),
  cpuUserMs: z.number().finite().nonnegative(),
  cpuSystemMs: z.number().finite().nonnegative(),
  rssBytes: z.number().int().nonnegative(),
  maxRssBytes: z.number().int().nonnegative(),
  readBytes: z.number().int().nonnegative().optional(),
  writeBytes: z.number().int().nonnegative().optional(),
  readCalls: z.number().int().nonnegative().optional(),
  copyMethod: z.enum(["backup", "vacuum"]),
  cacheKiB: z.number().int().min(2048).max(65536),
  mmapBytes: z.number().int().nonnegative(),
  effectiveMmapBytes: z.number().int().nonnegative().optional(),
});
export type DatasetPublishDiagnostic = z.infer<typeof datasetPublishDiagnosticSchema>;

export const datasetPublishProgressMessageSchema = z.object({
  type: z.literal("progress"), activity: datasetPublishActivitySchema,
});
export const datasetPublishDiagnosticMessageSchema = z.object({
  type: z.literal("diagnostic"), diagnostic: datasetPublishDiagnosticSchema,
});
