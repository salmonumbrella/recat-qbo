import type { Request, RequestHandler } from 'express';

interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys: number;
}

interface RateEntry {
  count: number;
  windowStartedAt: number;
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const MAX_KEYS = 100_000;
const MAX_LIMIT = 1_000_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;

export class BoundedRateLimiter {
  readonly #entries = new Map<string, RateEntry>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;

  constructor(options: RateLimiterOptions) {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_LIMIT ||
      !Number.isSafeInteger(options.windowMs) ||
      options.windowMs < 1 ||
      options.windowMs > MAX_WINDOW_MS ||
      !Number.isSafeInteger(options.maxKeys) ||
      options.maxKeys < 1 ||
      options.maxKeys > MAX_KEYS
    ) {
      throw new Error('Invalid bounded rate limiter configuration');
    }
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys;
  }

  get size(): number {
    return this.#entries.size;
  }

  acquire(key: string, now = Date.now()): RateLimitResult {
    const existing = this.#entries.get(key);
    if (
      existing === undefined ||
      now < existing.windowStartedAt ||
      now - existing.windowStartedAt >= this.#windowMs
    ) {
      if (existing === undefined && this.#entries.size >= this.#maxKeys) {
        const oldestKey = this.#entries.keys().next().value as string | undefined;
        if (oldestKey !== undefined) this.#entries.delete(oldestKey);
      } else if (existing !== undefined) {
        this.#entries.delete(key);
      }
      this.#entries.set(key, { count: 1, windowStartedAt: now });
      return { allowed: true };
    }

    this.#entries.delete(key);
    this.#entries.set(key, existing);
    if (existing.count >= this.#limit) {
      const remainingMs = Math.max(
        1,
        this.#windowMs - (now - existing.windowStartedAt),
      );
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
      };
    }
    existing.count += 1;
    return { allowed: true };
  }
}

interface RateLimitMiddlewareOptions {
  limiter: BoundedRateLimiter;
  key: (request: Request) => string;
  now?: () => number;
}

export function createRateLimitMiddleware(
  options: RateLimitMiddlewareOptions,
): RequestHandler {
  return (req, res, next) => {
    const result = options.limiter.acquire(
      options.key(req),
      options.now?.() ?? Date.now(),
    );
    if (result.allowed) {
      next();
      return;
    }
    res
      .status(429)
      .set('Retry-After', String(result.retryAfterSeconds))
      .json({ error: 'rate_limit_exceeded' });
  };
}

export function mcpIpRateLimitKey(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unresolved-ip';
}

export function mcpTokenRateLimitKey(request: Request): string {
  return request.auth?.token ?? 'missing-principal';
}
