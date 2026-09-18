import { afterEach, it } from 'vitest';
import { registerDeploymentTests } from '../deployment/deploy-suite.mjs';

// 개별 테스트로 등록해 전체 검증을 하나의 110초 제한에 묶지 않는다.
registerDeploymentTests({ test: it, afterEach });
