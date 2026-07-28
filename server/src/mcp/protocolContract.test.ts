import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as mcpExpress from '@modelcontextprotocol/express';
import * as mcpNode from '@modelcontextprotocol/node';
import * as mcpServer from '@modelcontextprotocol/server';
import * as zodV3 from 'zod';
import * as zodV4 from 'zod-v4';

const packageJsonUrl = new URL('../../package.json', import.meta.url);

describe('MCP protocol dependency contract', () => {
  it('uses the final v2 public server, Node, and Express entry points', () => {
    expect(mcpServer.McpServer).toBeTypeOf('function');
    expect(mcpServer.createMcpHandler).toBeTypeOf('function');
    expect(mcpNode.toNodeHandler).toBeTypeOf('function');
    expect(mcpExpress.requireBearerAuth).toBeTypeOf('function');
  });

  it('pins the final split packages and keeps Zod 4 isolated from application Zod 3', async () => {
    const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.dependencies).toMatchObject({
      '@modelcontextprotocol/express': '2.0.0',
      '@modelcontextprotocol/node': '2.0.0',
      '@modelcontextprotocol/server': '2.0.0',
      zod: '^3.24.1',
      'zod-v4': 'npm:zod@4.2.0',
    });
    expect(packageJson.devDependencies).toMatchObject({
      '@modelcontextprotocol/client': '2.0.0',
      '@modelcontextprotocol/conformance': '0.2.0-alpha.10',
    });

    expect(zodV3.ZodFirstPartyTypeKind).toBeDefined();
    expect(zodV4.toJSONSchema).toBeTypeOf('function');
    expect(zodV4).not.toBe(zodV3);
  });
});
