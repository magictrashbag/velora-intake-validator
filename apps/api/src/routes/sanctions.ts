import type { FastifyInstance } from 'fastify';
import type { Deps } from '../app.ts';
import { requireStaff } from '../staff.ts';
import { addSanctionedAddresses, type ListingEntry } from '../sanctions-lists.ts';

/** Compliance officers enter newly sanctioned crypto addresses (e.g. from an OFAC SDN update). */
export async function sanctionsRoutes(app: FastifyInstance, { db }: Deps) {
  app.post<{ Body: { source: string; entries: ListingEntry[]; note: string } }>('/v1/staff/sanctions/addresses', {
    onRequest: requireStaff(db, ['compliance_officer', 'admin']),
    schema: {
      body: {
        type: 'object', required: ['source', 'entries', 'note'], additionalProperties: false,
        properties: {
          source: { type: 'string', enum: ['ofac_sdn', 'un', 'eu', 'internal'] },
          note: { type: 'string', maxLength: 2000 },
          entries: {
            type: 'array', minItems: 1, maxItems: 1000,
            items: {
              type: 'object', required: ['network', 'address'], additionalProperties: false,
              properties: { network: { type: 'string' }, address: { type: 'string', maxLength: 100 }, listed_on: { type: 'string', format: 'date' } },
            },
          },
        },
      },
    },
  }, async (req) => addSanctionedAddresses(db, req.staff!.id, req.body.source, req.body.entries, req.body.note));
}
