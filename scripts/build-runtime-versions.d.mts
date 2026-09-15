import type { RuntimeVersions } from '../src/runtime/shared/runtime-versions.js';

export function generateRuntimeVersions(
  root?: string,
  overrides?: Readonly<Record<string, string>>,
): RuntimeVersions;
