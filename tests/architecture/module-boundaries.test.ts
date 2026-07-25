import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { cruise, type IReporterOutput } from 'dependency-cruiser';

const require = createRequire(import.meta.url);

describe('module boundaries (스펙 §7)', () => {
  it('has no forbidden dependencies', async () => {
    const ruleSet = require('../../.dependency-cruiser.cjs') as Record<string, unknown>;
    const result: IReporterOutput = await cruise(['src'], {
      ruleSet,
      validate: true,
      doNotFollow: { path: 'node_modules' },
    });

    const output = result.output;
    if (typeof output === 'string') {
      throw new Error(`unexpected string output: ${output}`);
    }

    const violations = output.summary.violations.map(
      (violation) => `${violation.rule.name}: ${violation.from} → ${violation.to}`,
    );
    expect(violations).toEqual([]);
  });
});
