import { afterEach, test } from 'node:test';
import { registerDeploymentTests } from './deploy-suite.mjs';

registerDeploymentTests({ test, afterEach });
