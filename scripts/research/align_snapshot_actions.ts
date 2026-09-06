import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { alignCorporateActionEffectiveDates, type SharesChange } from '../../src/server/modules/facts/domain/corporate-action-effective-date.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';

const db = new Database(process.argv[2]!, { readonly: true, fileMustExist: true });
const rows = db.prepare(`SELECT standard_code,short_code,valid_from_date,valid_to_date,shares_outstanding
  FROM symbol_master_versions ORDER BY standard_code,valid_from_date`).all() as {
    standard_code: string; short_code: string; valid_from_date: string;
    valid_to_date: string | null; shares_outstanding: string;
  }[];
const first = (db.prepare('SELECT min(date) AS date FROM symbol_master_trading_days').get() as { date: string }).date;
const changes: SharesChange[] = [];
for (let i = 1; i < rows.length; i += 1) {
  const before = rows[i - 1]!;
  const after = rows[i]!;
  // 운영 서비스와 같은 발행사·인접 SCD·최초 관측일 경계를 적용한다.
  if (before.standard_code !== after.standard_code
    || before.valid_to_date !== after.valid_from_date
    || after.valid_from_date <= first) continue;
  const beforeShares = Number(before.shares_outstanding);
  const afterShares = Number(after.shares_outstanding);
  if (!Number.isSafeInteger(beforeShares) || !Number.isSafeInteger(afterShares)
    || beforeShares <= 0 || afterShares <= 0 || beforeShares === afterShares) continue;
  changes.push({ shortCode: after.short_code, effectiveDate: after.valid_from_date,
    ratio: afterShares / beforeShares, beforeShares, afterShares });
}
const facts = db.prepare(`SELECT scope,key,field,period_key AS periodKey,as_of_ts_ms AS asOfTsMs,value,unit,
  corporate_action_before_shares AS corporateActionBeforeShares,
  corporate_action_after_shares AS corporateActionAfterShares FROM facts WHERE field='SPLIT_RATIO'`).all() as Fact[];
const aligned = alignCorporateActionEffectiveDates(facts, changes);
writeFileSync(process.argv[3]!, `${JSON.stringify({ ...aligned, changes }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ raw: facts.length, aligned: aligned.facts.length - aligned.unaligned.length,
  unaligned: aligned.unaligned.length, sharesChanges: changes.length })}\n`);
db.close();
