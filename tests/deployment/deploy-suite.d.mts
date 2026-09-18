export interface DeploymentTestRunner {
  test(name: string, body: () => void | Promise<void>): unknown;
  afterEach(body: () => void): unknown;
}

export function registerDeploymentTests(runner: DeploymentTestRunner): void;
