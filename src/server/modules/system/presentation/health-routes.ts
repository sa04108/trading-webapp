import fs from 'node:fs';
import os from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../../../bootstrap/container.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

function fileSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

async function freeDiskBytes(dirPath: string): Promise<number | null> {
  try {
    const stats = await fs.promises.statfs(dirPath);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** 스펙 §14 상태 엔드포인트. system/info 는 비밀값·민감 경로를 반환하지 않는다. */
export function registerSystemRoutes(
  app: FastifyInstance,
  container: Container,
  requireAuth: PreHandler,
): void {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      container.database.sqlite.prepare('SELECT 1').get();
      fs.accessSync(container.config.dataRoot, fs.constants.W_OK);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  app.get('/system/info', { preHandler: requireAuth }, async () => ({
    name: 'quant-platform',
    version: container.appVersion,
    gitCommitSha: container.gitCommitSha,
    uptimeSeconds: Math.floor(process.uptime()),
    databaseSizeBytes: fileSizeOrZero(container.config.databasePath),
    freeDiskBytes: await freeDiskBytes(container.config.dataRoot),
    freeMemoryBytes: os.freemem(),
    queueLength: container.systemStatus.queueLength(),
    runningJobs: container.systemStatus.runningJobs(),
    registeredSymbolCount: container.symbolService.countSymbols(),
  }));
}
