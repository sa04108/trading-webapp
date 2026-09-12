import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../../src/server/bootstrap/config.js';
import type { PreparationChildRequest } from '../../src/server/modules/backtest/application/backtest-preparation-execution.js';

// 첫 실행만 강제로 종료하고 재시도 자식은 실제 준비 작업을 수행한다.
process.once('message', async (message: {
  type: string;
  config: AppConfig;
  request: PreparationChildRequest;
}) => {
  if (message.type !== 'EXECUTE') return;
  const marker = path.join(message.config.tempRoot, 'preparation-first-crash');
  fs.mkdirSync(message.config.tempRoot, { recursive: true });
  if (message.request.type === 'RUN_JOB' && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'crashed');
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  await import('../../src/workers/backtest-preparation-child.js');
  process.emit('message', message, undefined);
});
