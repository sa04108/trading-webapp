import { defineConfig } from 'vitest/config';
import regressionConfig from './vitest.config.js';

// 대용량 검사는 서로 메모리를 경쟁하지 않도록 파일 하나씩 실행한다.
export default defineConfig({
  ...regressionConfig,
  test: {
    ...regressionConfig.test,
    include: ['tests/resources/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
