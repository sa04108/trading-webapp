import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import { createContainer, type Container } from '../../src/server/bootstrap/container.js';
import { buildServer } from '../../src/server/bootstrap/server.js';
import { newId } from '../../src/server/shared/ids.js';

export interface TestApp {
  app: FastifyInstance;
  container: Container;
  dir: string;
  close(): Promise<void>;
}

export async function createTestApp(
  env: Record<string, string> = {},
  configure?: (app: FastifyInstance) => void,
): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: path.join(dir, 'app.sqlite'),
    DATA_ROOT: path.join(dir, 'market-data'),
    IMPORT_ROOT: path.join(dir, 'imports'),
    EXPORT_ROOT: path.join(dir, 'exports'),
    TEMP_ROOT: path.join(dir, 'temp'),
    SESSION_SECRET: 's'.repeat(48),
    LOG_LEVEL: 'error',
    ...env,
  });
  const container = createContainer(config);
  const app = await buildServer(container);
  configure?.(app); // 테스트 전용 라우트 등록 등 — ready() 전에만 가능
  await app.ready();

  return {
    app,
    container,
    dir,
    async close() {
      await app.close();
      container.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestAdminOptions {
  username?: string;
  password?: string;
  totpEnabled?: boolean;
  recoveryCodes?: string[];
}

export async function createTestAdmin(
  container: Container,
  options: TestAdminOptions = {},
): Promise<{ username: string; password: string; totpSecret: string | null }> {
  const username = options.username ?? 'operator';
  const password = options.password ?? 'correct-horse-battery-staple';
  const totpEnabled = options.totpEnabled ?? false;
  const totpSecret = totpEnabled ? container.totpService.generateSecret() : null;

  const recoveryCodeHashes: string[] = [];
  for (const code of options.recoveryCodes ?? []) {
    recoveryCodeHashes.push(await container.passwordHasher.hash(code));
  }

  container.userRepository.create(
    {
      id: newId('usr'),
      username,
      passwordHash: await container.passwordHasher.hash(password),
      totpSecret,
      totpEnabled,
      recoveryCodeHashes,
    },
    container.clock.now(),
  );

  return { username, password, totpSecret };
}
