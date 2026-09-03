import { describe, expect, it, vi } from 'vitest';
import {
  SpanKind,
  SpanStatusCode,
  propagation,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  currentMcpTraceContext,
  mcpTraceCarrier,
  observeMcpToolCall,
} from './observability.js';

describe('MCP observability', () => {
  it('logs only bounded allowlisted metadata for successful and failed calls', async () => {
    const log = vi.fn();
    const value = await observeMcpToolCall(
      {
        requestId: 'request-a',
        traceId: 'a'.repeat(32),
        tokenPrefix: 'rct_SAFE',
        method: 'tools/call',
        tool: 'list_companies',
      },
      log,
      async () => ({ items: [1, 2] }),
    );

    expect(value).toEqual({ items: [1, 2] });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-a',
      traceId: 'a'.repeat(32),
      tokenPrefix: 'rct_SAFE',
      method: 'tools/call',
      tool: 'list_companies',
      count: 2,
      outcome: 'success',
      durationMs: expect.any(Number),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('items');

    await expect(observeMcpToolCall(
      { requestId: 'request-b', traceId: 'b'.repeat(32), tokenPrefix: 'rct_SAFE', method: 'tools/call', tool: 'get_transaction' },
      log,
      async () => { throw new Error('SECRET_SENTINEL'); },
    )).rejects.toThrow('SECRET_SENTINEL');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET_SENTINEL');
  });

  it('logs a bounded internal error identity without logging its message', async () => {
    const log = vi.fn();
    class QboDepositPreparationError extends Error {
      readonly code = 'QBO_DEPOSIT_UNSUPPORTED';

      constructor(message: string) {
        super(message);
        this.name = 'QboDepositPreparationError';
      }
    }
    const error = new QboDepositPreparationError('PRIVATE_PROVIDER_DETAIL');

    await expect(observeMcpToolCall(
      {
        requestId: 'request-deposit',
        traceId: 'd'.repeat(32),
        tokenPrefix: 'rct_SAFE',
        method: 'tools/call',
        tool: 'commit_categorization',
      },
      log,
      async () => { throw error; },
    )).rejects.toBe(error);

    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-deposit',
      tool: 'commit_categorization',
      outcome: 'error',
      errorClass: 'QboDepositPreparationError',
      errorCode: 'QBO_DEPOSIT_UNSUPPORTED',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_PROVIDER_DETAIL');
  });

  it('creates a server span and propagates only parsed trace context to application reads', async () => {
    const span = {
      setStatus: vi.fn().mockReturnThis(),
      recordException: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as Span;
    const tracer = {
      startSpan: vi.fn(() => span),
    } as unknown as Tracer;
    const traceContext = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      traceFlags: '01',
      tracestate: 'vendor=value',
      baggage: Object.freeze({
        'correlation-id': 'safe-correlation',
        deployment: 'test',
      }),
    };

    const value = await observeMcpToolCall(
      {
        requestId: 'server-request-id',
        traceId: traceContext.traceId,
        tokenPrefix: 'rct_SAFE',
        method: 'tools/call',
        tool: 'list_companies',
        era: 'modern',
        traceContext,
        tracer,
      },
      vi.fn(),
      async () => currentMcpTraceContext(),
    );

    expect(value).toEqual(traceContext);
    expect(currentMcpTraceContext()).toBeUndefined();
    expect(mcpTraceCarrier(traceContext)).toEqual({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=value',
      baggage: 'correlation-id=safe-correlation,deployment=test',
    });
    expect(tracer.startSpan).toHaveBeenCalledWith(
      'recat.mcp.request',
      {
        kind: SpanKind.SERVER,
        attributes: {
          'rpc.system': 'mcp',
          'rpc.method': 'tools/call',
          'mcp.tool.name': 'list_companies',
          'mcp.protocol.era': 'modern',
          'mcp.request.id': 'server-request-id',
        },
      },
      expect.anything(),
    );
    const parentContext = vi.mocked(tracer.startSpan).mock.calls[0]![2]!;
    expect(trace.getSpanContext(parentContext)).toMatchObject({
      traceId: traceContext.traceId,
      spanId: traceContext.parentSpanId,
      traceFlags: 1,
      isRemote: true,
    });
    expect(
      propagation.getBaggage(parentContext)?.getEntry('correlation-id')?.value,
    ).toBe('safe-correlation');
    expect(
      propagation.getBaggage(parentContext)?.getEntry('deployment')?.value,
    ).toBe('test');
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('marks failed spans without recording private exception details', async () => {
    const span = {
      setStatus: vi.fn().mockReturnThis(),
      recordException: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as Span;
    const tracer = { startSpan: vi.fn(() => span) } as unknown as Tracer;

    await expect(observeMcpToolCall(
      {
        requestId: 'server-request-id',
        traceId: 'a'.repeat(32),
        tokenPrefix: 'rct_SAFE',
        method: 'tools/call',
        tool: 'list_companies',
        era: 'legacy',
        traceContext: { traceId: 'a'.repeat(32), baggage: Object.freeze({}) },
        tracer,
      },
      vi.fn(),
      async () => { throw new Error('PRIVATE_EXCEPTION_SENTINEL'); },
    )).rejects.toThrow('PRIVATE_EXCEPTION_SENTINEL');

    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});
