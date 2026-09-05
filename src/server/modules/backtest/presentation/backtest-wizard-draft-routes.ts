import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  backtestWizardDraftContextSchema,
  backtestWizardDraftWritePayloadSchemas,
  backtestWizardDraftStepSchema,
} from '../../../../shared/schemas/backtest-wizard-draft.js';
import type { BacktestWizardDraftService } from '../application/backtest-wizard-draft-service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const stepParamsSchema = z.object({ step: backtestWizardDraftStepSchema });
const clearQuerySchema = backtestWizardDraftContextSchema.extend({
  all: z.literal('true').optional(),
}).refine(
  ({ all, sourceJobId }) => all === undefined || sourceJobId === undefined,
  { message: 'all과 sourceJobId는 함께 사용할 수 없습니다.' },
);

function validationError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

export function registerBacktestWizardDraftRoutes(
  app: FastifyInstance,
  drafts: BacktestWizardDraftService,
  requireAuth: PreHandler,
): void {
  app.get(
    '/backtests/wizard-draft',
    { preHandler: requireAuth },
    async (request) => ({
      candidate: drafts.getResumeCandidate(request.authUser!.id),
    }),
  );

  app.get(
    '/backtests/wizard-draft/:step',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = stepParamsSchema.safeParse(request.params);
      const query = backtestWizardDraftContextSchema.safeParse(request.query);
      if (!params.success) {
        return reply.code(400).send({ error: validationError(params.error) });
      }
      if (!query.success) {
        return reply.code(400).send({ error: validationError(query.error) });
      }
      return {
        draft: drafts.get(
          request.authUser!.id,
          query.data.sourceJobId,
          params.data.step,
        ),
      };
    },
  );

  app.put(
    '/backtests/wizard-draft/:step',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = stepParamsSchema.safeParse(request.params);
      const query = backtestWizardDraftContextSchema.safeParse(request.query);
      if (!params.success) {
        return reply.code(400).send({ error: validationError(params.error) });
      }
      if (!query.success) {
        return reply.code(400).send({ error: validationError(query.error) });
      }
      const payload = backtestWizardDraftWritePayloadSchemas[params.data.step].safeParse(request.body);
      if (!payload.success) {
        return reply.code(400).send({ error: validationError(payload.error) });
      }
      return {
        draft: drafts.save(
          request.authUser!.id,
          query.data.sourceJobId,
          params.data.step,
          payload.data,
        ),
      };
    },
  );

  app.delete(
    '/backtests/wizard-draft',
    { preHandler: requireAuth },
    async (request, reply) => {
      const query = clearQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: validationError(query.error) });
      }
      if (query.data.all === 'true') drafts.removeAll(request.authUser!.id);
      else drafts.remove(request.authUser!.id, query.data.sourceJobId);
      return reply.code(204).send();
    },
  );
}
