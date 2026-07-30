import { describe, expect, it, vi } from 'vitest';
import type { AttachmentBlobReader } from '../attachments/types.js';
import {
  ExtractorError,
  extractReceipt,
  type ExtractReceiptInput,
  type ExtractorClientDeps,
} from './extractorClient.js';

function blob(
  chunks: Uint8Array[] = [new Uint8Array([1, 2, 3])],
): AttachmentBlobReader {
  return {
    blobId: 'synthetic-blob',
    sizeBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    contentType: 'image/png',
    async *chunks() {
      yield* chunks;
    },
  };
}

function input(
  overrides: Partial<ExtractReceiptInput> = {},
): ExtractReceiptInput {
  return {
    requestId: '1f6d26c2-7332-4eb0-b93d-18d3ea625a30',
    filename: 'synthetic.png',
    contentType: 'image/png',
    blob: blob(),
    provider: {
      settings: {
        enabled: true,
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        confidenceThreshold: 0.8,
        autoMatchThreshold: 85,
        autoMatchMargin: 15,
        maxPages: 20,
        configVersion: 'a'.repeat(64),
      },
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'provider-private-key',
      headers: {
        'HTTP-Referer': 'https://recat.example.invalid',
        'X-Title': 'Recat',
      },
    },
    company: {
      names: ['Synthetic Company'],
      addresses: [],
      taxIds: [],
    },
    categories: {
      expense: [{ name: 'Office', description: 'Office costs' }],
      issued: [{ name: 'Revenue', description: 'Sales income' }],
    },
    ...overrides,
  };
}

function validExtractionResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 'recat-receipt-extraction/v1',
    prompt_version: 'receiptory-5afac9f0+recat-tax-components-v1',
    page_count: 1,
    extraction: {
      receipt_date: null,
      document_title: null,
      vendor_name: 'Synthetic Vendor',
      vendor_tax_id: null,
      vendor_receipt_id: null,
      client_name: null,
      client_tax_id: null,
      description: null,
      total_amount: 11.2,
      line_items: [{
        description: 'Synthetic item',
        quantity: '1',
        unit_price: '10',
      }],
      subtotal: '10',
      tax_amount: '1.2',
      currency: null,
      payment_method: null,
      payment_identifier: null,
      language: null,
      additional_fields: [],
      raw_extracted_text: null,
      document_type: 'expense_receipt',
      category: 'Office',
      extraction_confidence: 0.9,
      tax_components: [{
        label: 'Tax A',
        rate: 0.12,
        amount: '1.2',
        confidence: 0.9,
      }],
    },
    parse_salvaged: false,
    warnings: [],
    model: 'synthetic/model',
    tokens_in: 10,
    tokens_out: 20,
    cost_usd: '0.00007',
    duration_ms: 25,
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function deps(
  overrides: Partial<ExtractorClientDeps> = {},
): ExtractorClientDeps {
  return {
    fetch: vi.fn(async () => jsonResponse(validExtractionResponse())),
    url: 'http://extractor.test',
    token: 'service-private-token-value-123456',
    ...overrides,
  };
}

describe('private receipt extractor client', () => {
  it('sends bounded multipart bytes and service auth to the private worker', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const result = await extractReceipt(input(), deps({
      fetch: vi.fn(async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return jsonResponse(validExtractionResponse());
      }),
    }));

    expect(capturedUrl).toBe('http://extractor.test/v1/extract');
    expect(capturedInit?.headers).toEqual({
      'X-Recat-Extractor-Token': 'service-private-token-value-123456',
    });
    expect(capturedInit?.body).toBeInstanceOf(FormData);
    const form = capturedInit!.body as FormData;
    const workerRequest = JSON.parse(String(form.get('request'))) as Record<
      string,
      unknown
    >;
    expect(workerRequest).toMatchObject({
      request_id: input().requestId,
      api_base: input().provider.apiBase,
      api_key: 'provider-private-key',
      provider_headers: input().provider.headers,
      max_pages: 20,
    });
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('synthetic.png');
    expect((file as File).size).toBe(3);
    expect(result).toMatchObject({
      schemaVersion: 'recat-receipt-extraction/v1',
      pageCount: 1,
      extraction: {
        vendorName: 'Synthetic Vendor',
        totalAmount: '11.2',
        taxComponents: [{
          label: 'Tax A',
          rate: '0.12',
          amount: '1.2',
        }],
      },
    });
  });

  it('aborts at the configured timeout', async () => {
    const never = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    await expect(extractReceipt(
      input(),
      deps({ fetch: never, timeoutMs: 1 }),
    )).rejects.toMatchObject({
      code: 'RECEIPT_EXTRACTOR_TIMEOUT',
      transient: true,
    });
  });

  it('keeps the timeout active while reading the response body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([123]));
      },
    });
    await expect(extractReceipt(
      input(),
      deps({
        fetch: vi.fn(async () => new Response(stream)),
        timeoutMs: 5,
      }),
    )).rejects.toMatchObject({
      code: 'RECEIPT_EXTRACTOR_TIMEOUT',
      transient: true,
    });
  });

  it('keeps the timeout active while reading local blob bytes', async () => {
    const stalled: AttachmentBlobReader = {
      blobId: 'stalled-blob',
      sizeBytes: 1,
      contentType: 'image/png',
      async *chunks() {
        await new Promise(() => undefined);
        yield new Uint8Array([1]);
      },
    };
    await expect(extractReceipt(
      input({ blob: stalled }),
      deps({ timeoutMs: 5 }),
    )).rejects.toMatchObject({
      code: 'RECEIPT_EXTRACTOR_TIMEOUT',
      transient: true,
    });
  });

  it('never includes provider or service keys in thrown errors', async () => {
    const providerKey = input().provider.apiKey;
    const serviceKey = deps().token;
    let thrown: unknown;
    try {
      await extractReceipt(input(), deps({
        fetch: vi.fn(async () => {
          throw new Error(`${providerKey} ${serviceKey}`);
        }),
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExtractorError);
    expect(String(thrown)).not.toContain(providerKey);
    expect(String(thrown)).not.toContain(serviceKey);
  });

  it('rejects declared and streamed responses over one megabyte', async () => {
    const declared = new Response(null, {
      headers: { 'Content-Length': '1000001' },
    });
    await expect(extractReceipt(
      input(),
      deps({ fetch: vi.fn(async () => declared) }),
    )).rejects.toMatchObject({
      code: 'RECEIPT_EXTRACTOR_RESPONSE_TOO_LARGE',
      transient: false,
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    });
    await expect(extractReceipt(
      input(),
      deps({ fetch: vi.fn(async () => new Response(stream)) }),
    )).rejects.toMatchObject({
      code: 'RECEIPT_EXTRACTOR_RESPONSE_TOO_LARGE',
      transient: false,
    });
  });

  it('strictly rejects wrong versions, unknown keys, and non-finite money', async () => {
    for (const response of [
      validExtractionResponse({ schema_version: 'wrong-version' }),
      validExtractionResponse({ unexpected: true }),
      validExtractionResponse({
        extraction: {
          vendor_name: 'Synthetic',
          total_amount: 'NaN',
        },
      }),
    ]) {
      await expect(extractReceipt(
        input(),
        deps({ fetch: vi.fn(async () => jsonResponse(response)) }),
      )).rejects.toMatchObject({
        code: 'RECEIPT_EXTRACTOR_RESPONSE_INVALID',
        transient: false,
      });
    }
  });

  it('rejects values that cannot be persisted without truncation', async () => {
    for (const extraction of [
      { vendor_name: 'x'.repeat(501) },
      { receipt_date: '2026-02-30' },
      { total_amount: '1.00001' },
      { total_amount: '100000000000000' },
    ]) {
      await expect(extractReceipt(
        input(),
        deps({
          fetch: vi.fn(async () =>
            jsonResponse(validExtractionResponse({ extraction }))),
        }),
      )).rejects.toMatchObject({
        code: 'RECEIPT_EXTRACTOR_RESPONSE_INVALID',
        transient: false,
      });
    }
  });

  it('rejects response arrays and raw text beyond contract bounds', async () => {
    const extraction = {
      vendor_name: 'Synthetic',
      line_items: Array.from(
        { length: 1001 },
        () => ({ description: 'item' }),
      ),
      tax_components: Array.from(
        { length: 21 },
        () => ({ label: 'Tax A' }),
      ),
      additional_fields: Array.from(
        { length: 201 },
        () => ({ key: 'key', value: 'value' }),
      ),
      raw_extracted_text: 'x'.repeat(200_001),
    };
    await expect(extractReceipt(
      input(),
      deps({
        fetch: vi.fn(async () =>
          jsonResponse(validExtractionResponse({ extraction }))),
      }),
    )).rejects.toMatchObject({
      code: 'RECEIPT_EXTRACTOR_RESPONSE_INVALID',
      transient: false,
    });
  });

  it('preserves only a bounded worker code and transient classification', async () => {
    const response = jsonResponse({
      code: 'RECEIPT_PROVIDER_RATE_LIMIT',
      message: 'PRIVATE_WORKER_DETAIL',
      transient: true,
    }, { status: 503 });
    let thrown: unknown;
    try {
      await extractReceipt(
        input(),
        deps({ fetch: vi.fn(async () => response) }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'RECEIPT_PROVIDER_RATE_LIMIT',
      transient: true,
      message: 'Receipt extraction failed.',
    });
    expect(String(thrown)).not.toContain('PRIVATE_WORKER_DETAIL');
  });

  it('rejects blob metadata or streams beyond the input bound', async () => {
    const oversized = {
      ...blob(),
      sizeBytes: 100_000_001,
    };
    await expect(extractReceipt(
      input({ blob: oversized }),
      deps(),
    )).rejects.toMatchObject({
      code: 'RECEIPT_EXTRACTOR_INPUT_TOO_LARGE',
      transient: false,
    });
  });
});
