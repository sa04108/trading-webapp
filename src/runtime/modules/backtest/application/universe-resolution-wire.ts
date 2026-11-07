import { z } from "zod";
import { isoDateSchema } from "../../../../shared/schemas/backtest-request.js";
import { universeCriterionSchema, universeDirectionSchema } from "../../../../shared/schemas/universe-rule.js";
import type { UniverseResolveAttempt } from "./universe-rule-resolver.js";

const maxBytes = 8 * 1024 * 1024;
const code = z.string().regex(/^[0-9A-Z]{6}$/);
const standardCode = z.string().regex(/^[A-Z0-9]{12}$/);
const text = z.string().max(8192);
const count = z.number().int().nonnegative().safe();
const symbolEntry = z.object({
  standardCode, shortCode: code, name: text,
  market: z.enum(["KOSPI", "KOSDAQ"]), sharesOutstanding: text,
  instrumentType: z.enum(["COMMON_STOCK", "PREFERRED_STOCK", "REIT", "SPAC", "DR", "FUND_OR_TRUST", "NON_STOCK_SECURITY", "FOREIGN_LISTING", "UNKNOWN_CLASSIFICATION", "MISSING_BASE_INFO", "MISSING_SHARES"]),
  listedDate: isoDateSchema.nullable(),
}).passthrough();
const entries = z.array(z.tuple([code, symbolEntry])).max(10000).superRefine((rows, ctx) => {
  const seen = new Set<string>();
  rows.forEach(([key, value], index) => {
    if (seen.has(key) || key !== value.shortCode) ctx.addIssue({ code: "custom", path: [index], message: "종목 항목의 키가 중복되거나 단축코드와 다릅니다." });
    seen.add(key);
  });
});
const member = z.object({
  symbol: code, standardCode, marketCapKrw: text.nullable(),
  volume: z.number().finite().nullable(), tradingValueKrw: text.nullable(),
}).passthrough();
const schedule = z.object({
  rebalanceDate: isoDateSchema, effectiveDate: isoDateSchema,
  fromTsMs: z.number().finite(), members: z.array(member).max(200), excludedNonTradingCount: count,
}).passthrough();
const diagnostic = z.object({
  rebalanceDate: isoDateSchema, effectiveDate: isoDateSchema,
  stages: z.array(z.object({
    criterion: universeCriterionSchema, direction: universeDirectionSchema,
    inputCount: count, eligibleCount: count, selectedCount: count, excludedMissingCount: count,
  }).passthrough()).max(6),
}).passthrough();
const dataExclusion = z.object({
  symbol: code, category: z.enum(["KRX_CLASSIFICATION", "KRX_SELECTION_METRIC", "KRX_PRICE", "DART_FINANCIAL", "DART_CORPORATE_ACTION"]), periodKey: text, reason: text,
}).passthrough();
const actionExclusion = z.object({
  symbol: code, year: z.number().int().safe(), periodKey: text, reason: text,
  severity: z.enum(["BLOCKING", "INFORMATIONAL"]),
}).passthrough();
const wireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("READY"), schedule: z.array(schedule).max(6), diagnostics: z.array(diagnostic).max(6), unionEntries: entries,
    dataExclusions: z.array(dataExclusion), corporateActionExclusions: z.array(actionExclusion) }).passthrough(),
  z.object({ kind: z.literal("NEEDS_DATA"), candidateScopeKnown: z.boolean(), unionEntries: entries,
    needs: z.object({ factSymbols: z.array(code).max(10000), actionSymbols: z.array(code).max(10000), priceSymbols: z.array(code).max(10000), selectionMetricDates: z.array(isoDateSchema).max(6), priceRange: z.object({ from: isoDateSchema, to: isoDateSchema }).passthrough().nullable() }).passthrough() }).passthrough(),
]);

export function encodeUniverseResolution(result: UniverseResolveAttempt): string {
  const json = JSON.stringify({ ...result, unionEntries: [...result.unionEntries] });
  decodeUniverseResolution(json);
  return json;
}

export function decodeUniverseResolution(json: string): UniverseResolveAttempt {
  if (Buffer.byteLength(json, "utf8") > maxBytes) throw new Error("유니버스 결과 크기 제한을 초과했습니다.");
  const raw: unknown = JSON.parse(json);
  wireSchema.parse(raw);
  const parsed = raw as z.infer<typeof wireSchema>;
  if (parsed.kind === "READY") {
    const union = new Map(parsed.unionEntries);
    const seenUnion = new Set<string>();
    if (parsed.schedule.length !== parsed.diagnostics.length) throw new Error("일정과 진단의 길이가 다릅니다.");
    for (let i = 0; i < parsed.schedule.length; i += 1) {
      const date = parsed.schedule[i]!;
      const diagnostic = parsed.diagnostics[i]!;
      if (date.fromTsMs !== Date.parse(`${date.rebalanceDate}T00:00:00Z`) || date.effectiveDate > date.rebalanceDate || diagnostic.rebalanceDate !== date.rebalanceDate || diagnostic.effectiveDate !== date.effectiveDate) {
        throw new Error("일정의 날짜 또는 진단이 올바르지 않습니다.");
      }
      const seenSymbols = new Set<string>();
      const seenStandards = new Set<string>();
      for (const member of date.members) {
        if (seenSymbols.has(member.symbol) || seenStandards.has(member.standardCode) || union.get(member.symbol)?.standardCode !== member.standardCode) {
          throw new Error("일정의 종목 식별자가 올바르지 않습니다.");
        }
        seenSymbols.add(member.symbol);
        seenStandards.add(member.standardCode);
        seenUnion.add(member.symbol);
      }
      for (const stage of diagnostic.stages) {
        if (stage.eligibleCount > stage.inputCount || stage.selectedCount > stage.eligibleCount || stage.excludedMissingCount !== stage.inputCount - stage.eligibleCount) {
          throw new Error("진단의 종목 수가 올바르지 않습니다.");
        }
      }
    }
    if (seenUnion.size !== union.size) throw new Error("일정에 없는 종목 항목이 있습니다.");
  }
  return { ...parsed, unionEntries: new Map(parsed.unionEntries) };
}
