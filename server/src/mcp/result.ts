import type { CallToolResult, JSONObject } from '@modelcontextprotocol/server';
import { HttpError } from '../lib/http.js';
import { McpSchemaBoundsError } from './schemaBounds.js';

const MAX_REQUEST_ID_LENGTH = 128;

export type SafeToolErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'COMPANY_UNAVAILABLE'
  | 'QBO_DISCONNECTED'
  | 'RATE_LIMITED';

const SAFE_MESSAGES: Record<SafeToolErrorCode, string> = {
  FORBIDDEN: 'This token does not have access to the requested data. Check its company role and try again.',
  NOT_FOUND: 'The requested record was not found or is unavailable.',
  INVALID_INPUT: 'Check the tool arguments and try again.',
  COMPANY_UNAVAILABLE: 'The company data is temporarily unavailable. Try again later.',
  QBO_DISCONNECTED: 'QuickBooks is disconnected for this company. Reconnect it before retrying.',
  RATE_LIMITED: 'Too many requests were made. Wait briefly and try again.',
};

export const SAFE_INVALID_INPUT_MESSAGE = SAFE_MESSAGES.INVALID_INPUT;

export function toolSuccess<T extends JSONObject>(value: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeCode(error: unknown): SafeToolErrorCode {
  if (error instanceof McpSchemaBoundsError) return 'INVALID_INPUT';
  if (!(error instanceof HttpError)) return 'COMPANY_UNAVAILABLE';
  if (error.code === 'COMPANY_UNAVAILABLE') return 'COMPANY_UNAVAILABLE';
  if (error.code === 'QBO_DISCONNECTED') return 'QBO_DISCONNECTED';
  switch (error.status) {
    case 400:
      return 'INVALID_INPUT';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'COMPANY_UNAVAILABLE';
  }
}

export function safeToolFailure(
  error: unknown,
  requestId: string,
): CallToolResult {
  const code = safeCode(error);
  const value = {
    error: {
      code,
      message: SAFE_MESSAGES[code],
      requestId: requestId.slice(0, MAX_REQUEST_ID_LENGTH),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function safeInvalidToolFailure(requestId: string): CallToolResult {
  const value = {
    error: {
      code: 'INVALID_INPUT',
      message: SAFE_INVALID_INPUT_MESSAGE,
      requestId: requestId.slice(0, MAX_REQUEST_ID_LENGTH),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function isSafeToolFailure(
  value: unknown,
  requestId: string,
): boolean {
  if (value === null || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  const structured = result.structuredContent;
  if (structured === null || typeof structured !== 'object') return false;
  const error = (structured as Record<string, unknown>).error;
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  const code = candidate.code;
  return (
    typeof code === 'string' &&
    Object.hasOwn(SAFE_MESSAGES, code) &&
    candidate.message === SAFE_MESSAGES[code as SafeToolErrorCode] &&
    candidate.requestId === requestId.slice(0, MAX_REQUEST_ID_LENGTH)
  );
}
