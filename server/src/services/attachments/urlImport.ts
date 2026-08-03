import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { stageAttachment } from './blobStore.js';
import {
  type AttachmentBatchBudget,
  AttachmentError,
  type StageAttachmentInput,
  type StagedAttachmentDto,
} from './types.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_RESPONSE_HEADER_BYTES = 16_384;
const MAX_RESPONSE_HEADERS = 100;

export interface ImportHttpsAttachmentInput {
  companyId: string;
  actorKey: string;
  retainLocally: boolean;
  url: string;
  batchBudget: AttachmentBatchBudget;
  expiresAt: Date;
}

export interface PinnedTarget {
  url: URL;
  hostname: string;
  address: string;
  port: number;
}

export interface PinnedHttpsResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}

export interface UrlImportDependencies {
  resolve(hostname: string): Promise<readonly string[]>;
  request(target: PinnedTarget, signal: AbortSignal): Promise<PinnedHttpsResponse>;
  stage(input: StageAttachmentInput): Promise<StagedAttachmentDto>;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
}

function ipv4Number(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function publicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  return !blocked.some(([base, prefix]) =>
    ipv4InCidr(value, ipv4Number(base)!, prefix));
}

function parseIpv6(address: string): bigint | null {
  const withoutZone = address.toLowerCase().split('%', 1)[0]!;
  const pieces = withoutZone.split('::');
  if (pieces.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const output: number[] = [];
    for (const piece of side.split(':')) {
      if (piece.includes('.')) {
        const ipv4 = ipv4Number(piece);
        if (ipv4 === null) return null;
        output.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(piece)) return null;
        output.push(Number.parseInt(piece, 16));
      }
    }
    return output;
  };
  const left = parseSide(pieces[0] ?? '');
  const right = parseSide(pieces[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function ipv6Prefix(value: bigint, prefix: number): bigint {
  return value >> BigInt(128 - prefix);
}

function publicIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null || value === 0n || value === 1n) return false;
  const upper96 = value >> 32n;
  if (upper96 === 0n || upper96 === 0xffffn) {
    const embedded = Number(value & 0xffff_ffffn);
    const dotted = [
      (embedded >>> 24) & 0xff,
      (embedded >>> 16) & 0xff,
      (embedded >>> 8) & 0xff,
      embedded & 0xff,
    ].join('.');
    return publicIpv4(dotted);
  }
  // Only global unicast space is eligible, with special-purpose allocations
  // removed. This intentionally rejects deprecated site-local, translation,
  // documentation, and protocol-assignment ranges.
  if (ipv6Prefix(value, 3) !== 0x1n) return false; // 2000::/3
  const blocked: Array<[bigint, number]> = [
    [parseIpv6('2001::')!, 23],
    [parseIpv6('2001:2::')!, 48],
    [parseIpv6('2001:db8::')!, 32],
    [parseIpv6('2002::')!, 16],
    [parseIpv6('3fff::')!, 20],
  ];
  return !blocked.some(([base, prefix]) =>
    ipv6Prefix(value, prefix) === ipv6Prefix(base, prefix));
}

export function isPublicAttachmentAddress(input: string): boolean {
  const address = input.startsWith('[') && input.endsWith(']')
    ? input.slice(1, -1)
    : input;
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

function parseSafeHttpsUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new AttachmentError('ATTACHMENT_INVALID_INPUT', 'Attachment URL is invalid.');
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.hostname === ''
  ) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment URL must be credential-free HTTPS.',
    );
  }
  return url;
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export async function resolvePinnedHttpsTarget(
  inputUrl: URL,
  resolver: UrlImportDependencies['resolve'] = defaultResolve,
): Promise<PinnedTarget> {
  const url = parseSafeHttpsUrl(inputUrl);
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment host could not be resolved safely.',
    );
  }
  if (
    addresses.length === 0
    || addresses.some((address) => !isPublicAttachmentAddress(address))
  ) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'Attachment host is not publicly routable.',
    );
  }
  const port = url.port === '' ? 443 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new AttachmentError('ATTACHMENT_INVALID_INPUT', 'Attachment URL port is invalid.');
  }
  return {
    url,
    hostname,
    address: addresses[0]!,
    port,
  };
}

export function requestPinnedHttps(
  target: PinnedTarget,
  signal: AbortSignal,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<PinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: target.address,
      port: target.port,
      method: 'GET',
      path: `${target.url.pathname}${target.url.search}`,
      servername: isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      signal,
      headers: {
        Host: target.url.host,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        'User-Agent': 'Recat-Attachments/1',
      },
    }, (response) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      resolve({
        status: response.statusCode ?? 0,
        headers,
        body: response,
      });
    });
    request.once('socket', (socket) => {
      const timeout = setTimeout(() => {
        const error = new Error('HTTPS attachment connection timed out.');
        error.name = 'AbortError';
        request.destroy(error);
      }, connectTimeoutMs);
      const clear = () => clearTimeout(timeout);
      socket.once('secureConnect', clear);
      socket.once('error', clear);
      request.once('close', clear);
    });
    request.once('error', reject);
    request.end();
  });
}

function validateHeaders(headers: Readonly<Record<string, string>>): void {
  const entries = Object.entries(headers);
  const bytes = entries.reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value) + 4,
    0,
  );
  if (entries.length > MAX_RESPONSE_HEADERS || bytes > MAX_RESPONSE_HEADER_BYTES) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'HTTPS attachment response headers are too large.',
    );
  }
}

function contentLength(headers: Readonly<Record<string, string>>): number | null {
  const raw = headers['content-length'];
  if (raw === undefined) return null;
  if (!/^(0|[1-9]\d*)$/u.test(raw)) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'HTTPS attachment Content-Length is invalid.',
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new AttachmentError(
      'ATTACHMENT_TOO_LARGE',
      'HTTPS attachment Content-Length exceeds the safe range.',
    );
  }
  return parsed;
}

function decodedFilename(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function responseFilename(response: PinnedHttpsResponse, url: URL): string {
  const disposition = response.headers['content-disposition'];
  if (disposition) {
    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(disposition)?.[1];
    if (encoded) {
      const decoded = decodedFilename(encoded.trim());
      if (decoded) return decoded;
    }
    const quoted = /filename\s*=\s*"([^"]+)"/iu.exec(disposition)?.[1];
    if (quoted) return quoted.replace(/\\"/gu, '"');
    const plain = /filename\s*=\s*([^;]+)/iu.exec(disposition)?.[1]?.trim();
    if (plain) return plain;
  }
  const encodedPathname = url.pathname.split('/').at(-1) ?? '';
  return decodedFilename(encodedPathname) ?? encodedPathname;
}

async function* boundedResponseBody(
  responseBody: AsyncIterable<Uint8Array>,
  budget: AttachmentBatchBudget,
  declaredLength: number | null,
): AsyncIterable<Uint8Array> {
  let observed = 0;
  for await (const chunk of responseBody) {
    if (!(chunk instanceof Uint8Array)) {
      throw new AttachmentError(
        'ATTACHMENT_INVALID_INPUT',
        'HTTPS attachment response yielded invalid content.',
      );
    }
    observed += chunk.byteLength;
    if (declaredLength !== null && observed > declaredLength) {
      throw new AttachmentError(
        'ATTACHMENT_INVALID_INPUT',
        'HTTPS attachment response exceeded its Content-Length.',
      );
    }
    budget.consume(chunk.byteLength);
    yield chunk;
  }
  if (declaredLength !== null && observed !== declaredLength) {
    throw new AttachmentError(
      'ATTACHMENT_INVALID_INPUT',
      'HTTPS attachment response did not match its Content-Length.',
    );
  }
}

function isRedirect(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}

function safeTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

const defaultDependencies: UrlImportDependencies = {
  resolve: defaultResolve,
  request: (target, signal) => requestPinnedHttps(target, signal),
  stage: stageAttachment,
};

export async function importHttpsAttachment(
  input: ImportHttpsAttachmentInput,
  dependencies: UrlImportDependencies = defaultDependencies,
): Promise<StagedAttachmentDto> {
  let currentUrl = parseSafeHttpsUrl(input.url);
  const maxRedirects = Number.isSafeInteger(dependencies.maxRedirects)
    ? Math.max(0, Math.min(dependencies.maxRedirects!, DEFAULT_MAX_REDIRECTS))
    : DEFAULT_MAX_REDIRECTS;
  const totalTimeoutMs = safeTimeout(
    dependencies.totalTimeoutMs,
    DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const totalTimeout = setTimeout(() => controller.abort(), totalTimeoutMs);

  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      const target = await resolvePinnedHttpsTarget(currentUrl, dependencies.resolve);
      let response: PinnedHttpsResponse;
      try {
        response = await dependencies.request(target, controller.signal);
      } catch (error) {
        if (
          controller.signal.aborted
          || (error instanceof Error && error.name === 'AbortError')
        ) {
          throw new AttachmentError(
            'ATTACHMENT_BUSY',
            'HTTPS attachment import timed out.',
            true,
          );
        }
        throw new AttachmentError(
          'ATTACHMENT_BUSY',
          'HTTPS attachment import failed.',
          true,
        );
      }
      validateHeaders(response.headers);

      if (isRedirect(response.status)) {
        if (redirectCount >= maxRedirects) {
          throw new AttachmentError(
            'ATTACHMENT_INVALID_INPUT',
            'HTTPS attachment exceeded the redirect limit.',
          );
        }
        const location = response.headers.location;
        if (!location) {
          throw new AttachmentError(
            'ATTACHMENT_INVALID_INPUT',
            'HTTPS attachment redirect is missing a location.',
          );
        }
        try {
          currentUrl = parseSafeHttpsUrl(new URL(location, currentUrl));
        } catch (error) {
          if (error instanceof AttachmentError) throw error;
          throw new AttachmentError(
            'ATTACHMENT_INVALID_INPUT',
            'HTTPS attachment redirect is invalid.',
          );
        }
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new AttachmentError(
          'ATTACHMENT_INVALID_INPUT',
          'HTTPS attachment request did not return a successful response.',
        );
      }
      const encoding = response.headers['content-encoding']?.trim().toLowerCase();
      if (encoding !== undefined && encoding !== '' && encoding !== 'identity') {
        throw new AttachmentError(
          'ATTACHMENT_INVALID_INPUT',
          'Compressed HTTPS attachment responses are not accepted.',
        );
      }
      const declaredLength = contentLength(response.headers);
      if (
        declaredLength !== null
        && declaredLength > input.batchBudget.maxBytes - input.batchBudget.usedBytes
      ) {
        throw new AttachmentError(
          'ATTACHMENT_TOO_LARGE',
          'HTTPS attachment exceeds the remaining batch byte limit.',
        );
      }
      return await dependencies.stage({
        companyId: input.companyId,
        actorKey: input.actorKey,
        sourceKind: 'HTTPS_IMPORT',
        retainLocally: input.retainLocally,
        filename: responseFilename(response, currentUrl),
        declaredContentType: response.headers['content-type'] ?? null,
        content: boundedResponseBody(
          response.body,
          input.batchBudget,
          declaredLength,
        ),
        expiresAt: input.expiresAt,
      });
    }
  } finally {
    clearTimeout(totalTimeout);
  }
}
