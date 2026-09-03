import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  createTraceState,
  context as otelContext,
  propagation,
  trace as otelTrace,
  type Tracer,
} from '@opentelemetry/api';
import type { McpTraceContext } from './trace.js';

export interface McpToolLogContext {
  requestId: string;
  traceId: string;
  tokenPrefix: string;
  tokenPrefixPolicy?: 'include' | 'redact' | 'redact-for-transfer-result';
  method: string;
  tool: string;
  era?: 'legacy' | 'modern';
  traceContext?: McpTraceContext;
  tracer?: Tracer;
}

export interface McpToolLogEvent extends McpToolLogContext {
  durationMs: number;
  count: number;
  outcome: 'success' | 'error';
  errorClass?: string;
  errorCode?: string;
}

export type McpToolLogger = (event: McpToolLogEvent) => void;

const traceStorage = new AsyncLocalStorage<McpTraceContext>();

export function currentMcpTraceContext(): McpTraceContext | undefined {
  return traceStorage.getStore();
}

export function mcpTraceCarrier(
  traceContext: McpTraceContext,
): Record<string, string> {
  const carrier: Record<string, string> = {};
  if (
    traceContext.parentSpanId !== undefined &&
    traceContext.traceFlags !== undefined
  ) {
    carrier.traceparent =
      `00-${traceContext.traceId}-${traceContext.parentSpanId}-${traceContext.traceFlags}`;
  }
  if (traceContext.tracestate !== undefined) {
    carrier.tracestate = traceContext.tracestate;
  }
  const baggage = Object.entries(traceContext.baggage)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(',');
  if (baggage !== '') carrier.baggage = baggage;
  return carrier;
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function resultCount(value: unknown): number {
  if (
    value !== null &&
    typeof value === 'object' &&
    'items' in value &&
    Array.isArray((value as { items: unknown }).items)
  ) {
    return Math.min((value as { items: unknown[] }).items.length, 100);
  }
  return 1;
}

function internalErrorIdentity(error: unknown): {
  errorClass: string;
  errorCode?: string;
} {
  const errorClass = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(error.name)
    ? error.name
    : 'UnknownError';
  const candidate = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const errorCode = typeof candidate === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/u.test(candidate)
    ? candidate
    : undefined;
  return { errorClass, ...(errorCode === undefined ? {} : { errorCode }) };
}

function loggedTokenPrefix(
  context: McpToolLogContext,
  value: unknown,
  outcome: 'success' | 'error',
): string {
  const redact = context.tokenPrefixPolicy === 'redact'
    || (
      context.tokenPrefixPolicy === 'redact-for-transfer-result'
      && (
        outcome === 'error'
        || (
          value !== null
          && typeof value === 'object'
          && 'kind' in value
          && (value as { kind?: unknown }).kind === 'transfer'
        )
      )
    );
  return redact ? 'redacted' : bounded(context.tokenPrefix, 16);
}

export async function observeMcpToolCall<T>(
  context: McpToolLogContext,
  log: McpToolLogger,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const traceContext: McpTraceContext = context.traceContext ?? Object.freeze({
    traceId: context.traceId,
    baggage: Object.freeze({}),
  });
  let parentContext = ROOT_CONTEXT;
  if (
    traceContext.parentSpanId !== undefined &&
    traceContext.traceFlags !== undefined
  ) {
    parentContext = otelTrace.setSpanContext(parentContext, {
      traceId: traceContext.traceId,
      spanId: traceContext.parentSpanId,
      traceFlags: Number.parseInt(traceContext.traceFlags, 16),
      isRemote: true,
      ...(traceContext.tracestate === undefined
        ? {}
        : { traceState: createTraceState(traceContext.tracestate) }),
    });
  }
  const baggageEntries = Object.fromEntries(
    Object.entries(traceContext.baggage)
      .map(([key, value]) => [key, { value }]),
  );
  parentContext = propagation.setBaggage(
    parentContext,
    propagation.createBaggage(baggageEntries),
  );
  const tracer =
    context.tracer ?? otelTrace.getTracer('recat-qbo-mcp', '0.1.0');
  const span = tracer.startSpan(
    'recat.mcp.request',
    {
      kind: SpanKind.SERVER,
      attributes: {
        'rpc.system': 'mcp',
        'rpc.method': bounded(context.method, 64),
        'mcp.tool.name': bounded(context.tool, 64),
        'mcp.protocol.era': context.era ?? 'legacy',
        'mcp.request.id': bounded(context.requestId, 128),
      },
    },
    parentContext,
  );
  const activeContext = otelTrace.setSpan(parentContext, span);
  try {
    const value = await otelContext.with(
      activeContext,
      () => traceStorage.run(traceContext, operation),
    );
    span.setStatus({ code: SpanStatusCode.OK });
    log({
      requestId: bounded(context.requestId, 128),
      traceId: bounded(context.traceId, 64),
      tokenPrefix: loggedTokenPrefix(context, value, 'success'),
      method: bounded(context.method, 64),
      tool: bounded(context.tool, 64),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      count: resultCount(value),
      outcome: 'success',
    });
    return value;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    log({
      requestId: bounded(context.requestId, 128),
      traceId: bounded(context.traceId, 64),
      tokenPrefix: loggedTokenPrefix(context, undefined, 'error'),
      method: bounded(context.method, 64),
      tool: bounded(context.tool, 64),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      count: 0,
      outcome: 'error',
      ...internalErrorIdentity(error),
    });
    throw error;
  } finally {
    span.end();
  }
}
