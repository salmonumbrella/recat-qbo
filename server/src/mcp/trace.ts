import { randomBytes } from 'node:crypto';

const TRACEPARENT =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACESTATE_MAX_LENGTH = 512;
const SIMPLE_TRACESTATE_KEY = /^[a-z][a-z0-9_\-*\/]{0,255}$/;
const TENANT_TRACESTATE_ID = /^[a-z0-9][a-z0-9_\-*\/]{0,240}$/;
const SYSTEM_TRACESTATE_ID = /^[a-z][a-z0-9_\-*\/]{0,13}$/;
const TRACESTATE_VALUE =
  /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
const BAGGAGE_MAX_LENGTH = 1_024;
const BAGGAGE_MAX_ITEMS = 8;
const BAGGAGE_VALUE_MAX_LENGTH = 256;
const BAGGAGE_OCTETS = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const ALLOWED_BAGGAGE = new Set(['correlation-id', 'deployment']);

export interface McpTraceContext {
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly traceFlags?: string;
  readonly tracestate?: string;
  readonly baggage: Readonly<Record<string, string>>;
}

interface TraceHeaders {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
}

function validTraceparent(
  value: string | undefined,
): { traceId: string; parentSpanId: string; traceFlags: string } | null {
  if (value === undefined) return null;
  const match = TRACEPARENT.exec(value);
  if (
    match === null ||
    match[1] === '0'.repeat(32) ||
    match[2] === '0'.repeat(16)
  ) {
    return null;
  }
  return {
    traceId: match[1]!,
    parentSpanId: match[2]!,
    traceFlags: match[3]!,
  };
}

function validTracestate(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > TRACESTATE_MAX_LENGTH ||
    value !== value.trim()
  ) {
    return undefined;
  }
  const members = value.split(',');
  if (members.length > 32) return undefined;
  const keys = new Set<string>();
  const normalized: string[] = [];
  for (const rawMember of members) {
    const member = rawMember.trim();
    const separator = member.indexOf('=');
    if (separator < 1) return undefined;
    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    const at = key.indexOf('@');
    const validKey =
      at === -1
        ? SIMPLE_TRACESTATE_KEY.test(key)
        : key.indexOf('@', at + 1) === -1 &&
          TENANT_TRACESTATE_ID.test(key.slice(0, at)) &&
          SYSTEM_TRACESTATE_ID.test(key.slice(at + 1));
    if (!validKey || !TRACESTATE_VALUE.test(memberValue) || keys.has(key)) {
      return undefined;
    }
    keys.add(key);
    normalized.push(member);
  }
  return normalized.join(',');
}

function safeBaggage(value: string | undefined): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  if (value === undefined || value.length > BAGGAGE_MAX_LENGTH) {
    return Object.freeze(result);
  }
  const items = value.split(',');
  if (items.length > BAGGAGE_MAX_ITEMS) return Object.freeze(result);
  for (const item of items) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim().toLowerCase();
    if (!ALLOWED_BAGGAGE.has(key) || Object.hasOwn(result, key)) continue;
    const encodedValue = item.slice(separator + 1);
    if (
      encodedValue.length < 1 ||
      encodedValue.length > BAGGAGE_VALUE_MAX_LENGTH ||
      !BAGGAGE_OCTETS.test(encodedValue)
    ) {
      continue;
    }
    try {
      const decoded = decodeURIComponent(encodedValue);
      if (
        decoded.length < 1 ||
        decoded.length > BAGGAGE_VALUE_MAX_LENGTH ||
        !BAGGAGE_OCTETS.test(decoded)
      ) {
        continue;
      }
      result[key] = decoded;
    } catch {
      // Invalid percent encoding is discarded, never retained raw.
    }
  }
  return Object.freeze(result);
}

export function extractMcpTraceContext(headers: TraceHeaders): McpTraceContext {
  const parent = validTraceparent(headers.traceparent);
  const tracestate =
    parent === null ? undefined : validTracestate(headers.tracestate);
  const context: McpTraceContext = {
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    ...(parent === null
      ? {}
      : {
          parentSpanId: parent.parentSpanId,
          traceFlags: parent.traceFlags,
        }),
    ...(tracestate === undefined ? {} : { tracestate }),
    baggage: safeBaggage(headers.baggage),
  };
  return Object.freeze(context);
}
