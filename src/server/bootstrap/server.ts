import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Container } from './container.js';
import { buildPinoOptions } from '../shared/logger.js';
import { registerSecurity } from '../shared/security.js';
import '../shared/fastify-augment.js';
import { registerSystemRoutes } from '../modules/system/presentation/health-routes.js';
import {
  createRequireAuth,
  registerAuthRoutes,
} from '../modules/auth/presentation/auth-routes.js';
import { registerDatasetRoutes } from '../modules/market-data/presentation/dataset-routes.js';

function resolvePublicDir(): string | null {
  // 빌드 후: dist/server/bootstrap → dist/public. 개발 중에는 Vite dev 서버를 사용한다.
  const candidate = fileURLToPath(new URL('../../public', import.meta.url));
  return fs.existsSync(path.join(candidate, 'index.html')) ? candidate : null;
}

export async function buildServer(container: Container): Promise<FastifyInstance> {
  const { config } = container;

  const app = Fastify({
    logger: buildPinoOptions(config),
    trustProxy: config.trustProxyLoopback ? '127.0.0.1' : false,
    bodyLimit: 10 * 1024 * 1024,
  });

  registerSecurity(app);

  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  });

  const authDeps = {
    authService: container.authService,
    secureCookies: config.nodeEnv === 'production',
  };
  const requireAuth = createRequireAuth(authDeps);

  await app.register(
    async (api) => {
      registerSystemRoutes(api, container, requireAuth);
      registerAuthRoutes(api, authDeps);
      registerDatasetRoutes(api, container.datasetService, requireAuth);
    },
    { prefix: '/api/v1' },
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // 스펙 §16: stack trace 미노출
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : error.message,
    });
  });

  const publicDir = resolvePublicDir();
  if (publicDir) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.type('text/html').send(fs.createReadStream(path.join(publicDir, 'index.html')));
      }
      return reply.code(404).send({ error: 'Not Found' });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not Found' }));
  }

  return app;
}
