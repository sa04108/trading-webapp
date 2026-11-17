import { z } from "zod";

export const openApiTokenIssueSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["READ_ONLY", "READ_WRITE"]).default("READ_WRITE"),
  expiresInDays: z.number().int().min(1).max(3650).default(365),
}).strict();
export type OpenApiTokenScope = z.infer<typeof openApiTokenIssueSchema>["scope"];
export interface OpenApiTokenRecord {
  id: string;
  name: string;
  prefix: string;
  scope: OpenApiTokenScope;
  createdAtMs: number;
  expiresAtMs: number;
  lastUsedAtMs: number | null;
  revokedAtMs: number | null;
}
