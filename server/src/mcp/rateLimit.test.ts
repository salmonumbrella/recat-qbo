import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createRecatBearerAuth, createRecatTokenVerifier } from './auth.js';
import { BoundedRateLimiter, createRateLimitMiddleware } from './rateLimit.js';

describe('BoundedRateLimiter', () => {
  it('isolates keys and supplies a bounded Retry-After', () => {
    const limiter = new BoundedRateLimiter({ limit: 2, windowMs: 1_000, maxKeys: 10 });
    expect(limiter.acquire('token-a', 0)).toEqual({ allowed: true });
    expect(limiter.acquire('token-a', 1)).toEqual({ allowed: true });
    expect(limiter.acquire('token-b', 2)).toEqual({ allowed: true });
    expect(limiter.acquire('token-a', 3)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it('expires old attempts and never retains more than maxKeys', () => {
    const limiter = new BoundedRateLimiter({ limit: 1, windowMs: 100, maxKeys: 2 });
    limiter.acquire('a', 0);
    limiter.acquire('b', 1);
    limiter.acquire('c', 2);
    expect(limiter.size).toBe(2);
    expect(limiter.acquire('a', 3)).toEqual({ allowed: true });
    expect(limiter.size).toBe(2);
    expect(limiter.acquire('a', 200)).toEqual({ allowed: true });
  });

  it('validates bounds instead of allowing unbounded memory configuration', () => {
    expect(
      () => new BoundedRateLimiter({ limit: 0, windowMs: 1_000, maxKeys: 1 }),
    ).toThrow();
    expect(
      () => new BoundedRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 0 }),
    ).toThrow();
  });

  it('throttles an IP before repeated invalid tokens can query storage', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const verifier = createRecatTokenVerifier({
      db: {
        mcpToken: {
          findUnique,
          updateMany: vi.fn(),
        },
      },
    });
    const app = express();
    app.use(
      createRateLimitMiddleware({
        limiter: new BoundedRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 }),
        key: () => 'test-ip',
        now: () => 0,
      }),
    );
    app.use(createRecatBearerAuth(verifier));
    app.post('/mcp', (_req, res) => res.status(204).end());
    const token = `rct_${'Z'.repeat(43)}`;

    await request(app).post('/mcp').set('Authorization', `Bearer ${token}`).send({}).expect(401);
    const throttled = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(429);

    expect(throttled.headers['retry-after']).toBe('60');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
