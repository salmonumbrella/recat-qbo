import { describe, expect, it } from 'vitest';
import { extractMcpTraceContext } from './trace.js';

const VALID_TRACEPARENT =
  '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('extractMcpTraceContext', () => {
  it('extracts valid W3C trace context and only allowlisted bounded baggage', () => {
    const context = extractMcpTraceContext({
      traceparent: VALID_TRACEPARENT,
      tracestate: 'vendor=value',
      baggage: 'correlation-id=req-123,secret=do-not-keep,deployment=edge',
    });

    expect(context).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      traceFlags: '01',
      tracestate: 'vendor=value',
      baggage: { 'correlation-id': 'req-123', deployment: 'edge' },
    });
    expect(JSON.stringify(context)).not.toContain('do-not-keep');
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('ignores malformed trace metadata without throwing or changing request identity', () => {
    const context = extractMcpTraceContext({
      traceparent: 'not-a-trace',
      tracestate: 'vendor=value',
      baggage: `correlation-id=${'x'.repeat(300)}`,
    });

    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.parentSpanId).toBeUndefined();
    expect(context.tracestate).toBeUndefined();
    expect(context.baggage).toEqual({});
  });

  it('drops tracestate when there is no traceparent', () => {
    const context = extractMcpTraceContext({ tracestate: 'vendor=value' });

    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.parentSpanId).toBeUndefined();
    expect(context.tracestate).toBeUndefined();
  });

  it('fails closed when incoming baggage exceeds the total item bound', () => {
    const baggage = Array.from({ length: 40 }, (_, i) => `correlation-id=v${i}`).join(',');
    const context = extractMcpTraceContext({ baggage });
    expect(context.baggage).toEqual({});

    const unknownsThenAllowed = [
      ...Array.from({ length: 8 }, (_, i) => `unknown-${i}=value`),
      'correlation-id=must-not-survive',
    ].join(',');
    expect(extractMcpTraceContext({ baggage: unknownsThenAllowed }).baggage).toEqual({});
  });

  it('accepts only W3C baggage-octets and rejects decoded delimiters', () => {
    const baggage = (value: string) =>
      extractMcpTraceContext({
        baggage: `correlation-id=${value}`,
      }).baggage;

    expect(baggage('req%2D123')).toEqual({ 'correlation-id': 'req-123' });
    expect(baggage('req 123')).toEqual({});
    expect(baggage('req"123')).toEqual({});
    expect(baggage('req;property=value')).toEqual({});
    expect(baggage('req\\123')).toEqual({});
    expect(baggage('req%2C123')).toEqual({});
    expect(baggage('req%3B123')).toEqual({});
    expect(baggage('req%5C123')).toEqual({});
  });

  it('validates W3C simple and multi-tenant tracestate keys and rejects duplicates', () => {
    const state = (tracestate: string) =>
      extractMcpTraceContext({
        traceparent: VALID_TRACEPARENT,
        tracestate,
      }).tracestate;

    expect(state('1vendor=value')).toBeUndefined();
    expect(state('1tenant@system=value')).toBe('1tenant@system=value');
    expect(state('tenant@system=value')).toBe('tenant@system=value');
    expect(state('vendor=first,vendor=second')).toBeUndefined();
  });

  it('enforces W3C tracestate key and value length boundaries', () => {
    const state = (tracestate: string) =>
      extractMcpTraceContext({
        traceparent: VALID_TRACEPARENT,
        tracestate,
      }).tracestate;
    const simpleKey = `a${'0'.repeat(255)}`;
    const multiTenantKey = `${'1'.repeat(241)}@s${'0'.repeat(13)}`;

    expect(state(`${simpleKey}=value`)).toBe(`${simpleKey}=value`);
    expect(state(`${simpleKey}0=value`)).toBeUndefined();
    expect(state(`${multiTenantKey}=value`)).toBe(`${multiTenantKey}=value`);
    expect(state(`${'1'.repeat(242)}@system=value`)).toBeUndefined();
    expect(state(`tenant@s${'0'.repeat(14)}=value`)).toBeUndefined();
    expect(state(`vendor=${'v'.repeat(256)}`)).toBe(`vendor=${'v'.repeat(256)}`);
    expect(state(`vendor=${'v'.repeat(257)}`)).toBeUndefined();
    expect(state('vendor=value ')).toBeUndefined();
  });
});
