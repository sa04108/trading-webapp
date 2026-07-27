import { configureZodLocale } from '../shared/zod-locale.js';
import { loadConfig } from './config.js';
import { createContainer } from './container.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  configureZodLocale();
  const config = loadConfig();
  const container = createContainer(config);
  const app = await buildServer(container);

  await app.listen({ host: config.bindAddress, port: config.port });
  container.jobOrchestrator.start();
  const withoutTotp = container.userRepository.listUsernamesWithoutTotp();
  if (withoutTotp.length > 0) {
    container.logger.warn(
      { module: 'bootstrap', event: 'auth.totp.not-enrolled', usernames: withoutTotp },
      'TOTP 미등록 계정 — 퍼블릭 노출 전에 totp:enroll 로 등록하라 (D-017)',
    );
  }
  container.logger.info(
    { module: 'bootstrap', event: 'server.started', address: config.bindAddress, port: config.port },
    'server started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info({ module: 'bootstrap', event: 'server.stopping', signal }, 'shutting down');
    await app.close();
    container.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
