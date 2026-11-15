import { z } from "zod";

export const historyQuerySchema = z.object({
  strategyId: z.string().min(1).max(200).optional(),
  sort: z
    .enum(["createdAt", "periodEnd", "duration", "returnPct", "cagrPct"])
    .default("createdAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
});

export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type HistorySort = HistoryQuery["sort"];
export type HistoryDirection = HistoryQuery["dir"];
export interface HistoryGroup {
  strategyId: string;
  total: number;
}
