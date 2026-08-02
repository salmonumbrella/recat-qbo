import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Recat MCP authored schema startup validation', () => {
  it('allows fresh module startup when static conversion spans hundreds of milliseconds', async () => {
    let simulatedNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      simulatedNow += 100;
      return simulatedNow;
    });
    vi.resetModules();

    await expect(import('./readTools.js')).resolves.toHaveProperty(
      'createRecatMcpServer',
    );
  });

  it('still fails closed when static conversion exceeds its startup budget', async () => {
    let simulatedNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      simulatedNow += 6_000;
      return simulatedNow;
    });
    vi.resetModules();

    await expect(import('./readTools.js')).rejects.toMatchObject({
      code: 'VALIDATION_TIME',
    });
  });
});
