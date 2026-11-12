import type { FastifyInstance } from 'fastify';
import type { Deps } from '../app.ts';
import { requireStaff } from '../staff.ts';
import { actOnCase, type ReviewAction } from '../review.ts';
import { AppError } from '../errors.ts';
import { jsonBigint } from '../audit.ts';

const toJson = (v: unknown) => JSON.parse(JSON.stringify(v, jsonBigint));

/** Internal review console API. Staff see FULL internal reasons; customers never do. */
export async function staffRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const auth = requireStaff(db);

  app.get<{ Querystring: { status?: string } }>('/v1/staff/cases', {
    onRequest: auth,
    schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'awaiting_second_approval', 'approved', 'rejected', 'blocked'] } } } },
  }, async (req) => {
    const statuses = req.query.status ? [req.query.status] : ['open', 'awaiting_second_approval'];
    const r = await db.query(
      `SELECT c.id, c.subject_type, c.subject_id, c.user_id, c.reasons, c.status, c.opened_at,
              u.phone, u.kyc_tier, u.screening, u.country
         FROM review_cases c JOIN users u ON u.id = c.user_id
        WHERE c.status = ANY($1) ORDER BY c.opened_at LIMIT 200`, [statuses]);
    return { cases: toJson(r.rows) };
  });

  app.get<{ Params: { id: string } }>('/v1/staff/cases/:id', {
    onRequest: auth,
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => {
    const c = (await db.query('SELECT * FROM review_cases WHERE id = $1', [req.params.id])).rows[0];
    if (!c) throw new AppError(404, 'case_not_found');
    const subject = c.subject_type === 'transfer'
      ? (await db.query('SELECT id, kind, currency, amount_minor, amount_usd_cents, status, details, created_at FROM transfers WHERE id = $1', [c.subject_id])).rows[0]
      : c.subject_type === 'deposit'
        ? (await db.query('SELECT id, network, tx_hash, from_address, amount_minor, disposition, created_at FROM crypto_deposits WHERE id = $1', [c.subject_id])).rows[0]
        : (await db.query('SELECT id, phone, status, kyc_tier, screening, country FROM users WHERE id = $1', [c.subject_id])).rows[0];
    const col = c.subject_type === 'deposit' ? 'deposit_id' : 'transfer_id';
    const decisions = c.subject_type === 'user' ? [] :
      (await db.query(`SELECT outcome, reasons, context, policy_version, created_at FROM compliance_decisions WHERE ${col} = $1 ORDER BY id`, [c.subject_id])).rows;
    const actions = (await db.query(
      `SELECT a.action, a.note, a.created_at, s.email FROM review_actions a JOIN staff s ON s.id = a.staff_id WHERE case_id = $1 ORDER BY a.id`,
      [c.id])).rows;
    return toJson({ case: c, subject, decisions, actions });
  });

  app.post<{ Params: { id: string; action: ReviewAction }; Body: { note: string } }>('/v1/staff/cases/:id/:action', {
    onRequest: auth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, action: { type: 'string', enum: ['approve', 'reject', 'block', 'comment'] } } },
      body: { type: 'object', required: ['note'], additionalProperties: false, properties: { note: { type: 'string', maxLength: 2000 } } },
    },
  }, async (req, reply) => {
    const out = await actOnCase(deps, req.staff!, req.params.id, req.params.action, req.body.note, req.ip);
    if (out.refused_reasons) reply.code(409);
    return out;
  });
}
