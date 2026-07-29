import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { runClaimedShadowJob } from './worker.js';

describe('shadow worker safety boundary', () => {
  it('does not import staging, writeback, transfer, QBO, network, or filesystem mutation services', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const fileName = join(directory, 'worker.ts');
    const source = readFileSync(fileName, 'utf8');
    const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    parsed.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
    });

    expect(imports).toEqual([
      './core/decision.js',
      './core/model.js',
      './core/runner.js',
      './core/snapshot.js',
      './jobs.js',
      './snapshotLoader.js',
    ]);
    expect(source).not.toMatch(
      /stageCategorization|commitStagedCategorization|writeback|transfer|qboFactory|sendPreparedWrite|fetch\(/u,
    );
  });

  it('exports the claimed-job entry point without mutation service dependencies', () => {
    expect(runClaimedShadowJob).toBeTypeOf('function');
  });
});
