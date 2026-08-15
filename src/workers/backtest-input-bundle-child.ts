import { SqliteBacktestInputBundleBuilder } from '../server/modules/backtest/infrastructure/sqlite-backtest-input-bundle-builder.js';

function main(): void {
  const sourceDatabasePath = process.env.SOURCE_DATABASE_PATH;
  const destinationPath = process.env.BUNDLE_PATH;
  const jobId = process.env.BACKTEST_JOB_ID ?? process.argv[2];
  if (!sourceDatabasePath || !destinationPath || !jobId) {
    throw new Error('SOURCE_DATABASE_PATH / BUNDLE_PATH / BACKTEST_JOB_ID가 필요합니다');
  }
  new SqliteBacktestInputBundleBuilder().build(sourceDatabasePath, destinationPath, jobId);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
