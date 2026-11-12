import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../console');
const FILES: Record<string, { file: string; type: string }> = {
  '/staff': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/staff/console.js': { file: 'console.js', type: 'text/javascript; charset=utf-8' },
  '/staff/console.css': { file: 'console.css', type: 'text/css; charset=utf-8' },
};

/** Static shell for the review console. All data comes from the authenticated /v1/staff API. */
export async function consoleRoutes(app: FastifyInstance) {
  for (const [url, f] of Object.entries(FILES)) {
    const body = readFileSync(path.join(DIR, f.file));
    app.get(url, async (_req, reply) => {
      reply
        .header('content-type', f.type)
        .header('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        .header('x-frame-options', 'DENY')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'no-store');
      return body;
    });
  }
}
