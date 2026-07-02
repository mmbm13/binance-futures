import { FastifyReply, FastifyRequest } from 'fastify';

/** When API_KEY is set, require Bearer token or ?token= on protected routes. */
export function requireApiKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const key = process.env.API_KEY;
  if (!key) return true;

  const auth = request.headers.authorization;
  const query = (request.query as { token?: string }).token;

  if (auth === `Bearer ${key}` || query === key) return true;

  reply.code(401).send({ error: 'Unauthorized — set Authorization: Bearer <API_KEY> or ?token=' });
  return false;
}
