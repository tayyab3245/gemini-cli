/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadPrompt } from '../mindLoader.js';

// Mock the filesystem module
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    promises: {
      access: vi.fn(),
      readFile: vi.fn(),
    },
  };
});

const mockFs = vi.mocked(fs);

describe('mindLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock process.cwd() to return consistent test path
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadPrompt', () => {
    describe('file discovery', () => {
      it('should try .ts extension first, then .js', async () => {
        // Mock .ts file not found, .js file found
        mockFs.access
          .mockRejectedValueOnce(new Error('ENOENT'))  // .ts file not found
          .mockResolvedValueOnce(undefined);           // .js file found

        mockFs.readFile.mockResolvedValueOnce('export default `test prompt`;');

        const result = await loadPrompt('test.prompt');

        expect(mockFs.access).toHaveBeenCalledTimes(2);
        expect(mockFs.access).toHaveBeenNthCalledWith(1, path.join('/test/project/packages/core/src/mind', 'test.prompt.ts'));
        expect(mockFs.access).toHaveBeenNthCalledWith(2, path.join('/test/project/packages/core/src/mind', 'test.prompt.js'));
        expect(result).toBe('test prompt');
      });

      it('should return null if neither .ts nor .js file exists', async () => {
        mockFs.access
          .mockRejectedValueOnce(new Error('ENOENT'))  // .ts file not found
          .mockRejectedValueOnce(new Error('ENOENT')); // .js file not found

        const result = await loadPrompt('nonexistent.prompt');

        expect(result).toBe(null);
      });

      it('should use .ts file if it exists', async () => {
        mockFs.access.mockResolvedValueOnce(undefined); // .ts file found
        mockFs.readFile.mockResolvedValueOnce('export default `ts prompt`;');

        const result = await loadPrompt('test.prompt');

        expect(mockFs.access).toHaveBeenCalledTimes(1);
        expect(mockFs.readFile).toHaveBeenCalledWith(
          path.join('/test/project/packages/core/src/mind', 'test.prompt.ts'),
          'utf-8'
        );
        expect(result).toBe('ts prompt');
      });
    });

    describe('literal export patterns', () => {
      it('should parse export default with template literal', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('export default `This is a test prompt`;');

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('This is a test prompt');
      });

      it('should parse export default with double quotes', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('export default "Double quoted prompt";');

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Double quoted prompt');
      });

      it('should parse export default with single quotes', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce("export default 'Single quoted prompt';");

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Single quoted prompt');
      });

      it('should parse export default = with template literal', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('export default = `Assignment with template literal`;');

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Assignment with template literal');
      });

      it('should handle multi-line template literals', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const multiLineContent = `export default \`This is a
multi-line template literal
with multiple lines\`;`;
        mockFs.readFile.mockResolvedValueOnce(multiLineContent);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe(`This is a
multi-line template literal
with multiple lines`);
      });

      it('should handle nested backticks in template literals', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('export default `This has nested `backticks` inside`;');

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('This has nested `backticks` inside');
      });

      it('should handle escaped quotes in string literals', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('export default "String with \\"escaped quotes\\"";');

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('String with "escaped quotes"');
      });
    });

    describe('variable export patterns', () => {
      it('should parse const variable with template literal export', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = \`This is a variable-exported prompt\`;

export default prompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('This is a variable-exported prompt');
      });

      it('should parse let variable with double quotes', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `let myPrompt = "Let variable with double quotes";

export default myPrompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Let variable with double quotes');
      });

      it('should parse var variable with single quotes', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `var promptContent = 'Var variable with single quotes';

export default promptContent;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Var variable with single quotes');
      });

      it('should handle multi-line template literal in variable', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = \`This is a
multi-line template literal
assigned to a variable
with various content\`;

export default prompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe(`This is a
multi-line template literal
assigned to a variable
with various content`);
      });

      it('should handle complex template literal with nested backticks and quotes', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = \`Complex template with:
- \`nested backticks\`
- "double quotes"
- 'single quotes'
- \${interpolation} syntax\`;

export default prompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe(`Complex template with:
- \`nested backticks\`
- "double quotes"
- 'single quotes'
- \${interpolation} syntax`);
      });

      it('should handle variable names with underscores and numbers', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const _prompt_v2 = \`Variable with underscores and numbers\`;

export default _prompt_v2;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Variable with underscores and numbers');
      });

      it('should handle escaped quotes in variable string literals', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = "String with \\"escaped quotes\\" in variable";

export default prompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('String with "escaped quotes" in variable');
      });
    });

    describe('mixed patterns in same file', () => {
      it('should prefer literal export over variable export', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = \`This is the variable\`;

export default \`This is the literal export\`;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('This is the literal export');
      });

      it('should handle comments and other code around exports', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `/**
 * This is a comment
 */

import { something } from 'somewhere';

const prompt = \`This is the actual prompt content\`;

// Another comment
function someFunction() {
  return 'not relevant';
}

export default prompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('This is the actual prompt content');
      });
    });

    describe('edge cases and file formats', () => {
      it('should work with .ts files (development)', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = \`TypeScript development file content\`;

export default prompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('TypeScript development file content');
      });

      it('should work with .js files (production build)', async () => {
        mockFs.access
          .mockRejectedValueOnce(new Error('ENOENT'))  // .ts not found
          .mockResolvedValueOnce(undefined);           // .js found

        const content = `const prompt = \`JavaScript production build content\`;

export default prompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('JavaScript production build content');
      });

      it('should handle whitespace variations in export statements', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const   prompt   =   \`Content with whitespace\`  ;


export   default   prompt   ;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Content with whitespace');
      });
    });

    describe('error handling', () => {
      it('should throw contract violation error for non-string exports', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('export default 42;');

        await expect(loadPrompt('test.prompt')).rejects.toThrow(
          'loadPrompt() could not parse prompt file'
        );
      });

      it('should throw contract violation error for object exports', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('export default { prompt: "value" };');

        await expect(loadPrompt('test.prompt')).rejects.toThrow(
          'loadPrompt() could not parse prompt file'
        );
      });

      it('should throw contract violation error for variable pointing to non-string', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = 42;

export default prompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        await expect(loadPrompt('test.prompt')).rejects.toThrow(
          'loadPrompt() could not parse prompt file'
        );
      });

      it('should throw contract violation error for undefined variable', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('export default nonExistentVariable;');

        await expect(loadPrompt('test.prompt')).rejects.toThrow(
          'loadPrompt() could not parse prompt file'
        );
      });

      it('should throw error for empty string content', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('export default ``;');

        await expect(loadPrompt('test.prompt')).rejects.toThrow(
          'loadPrompt() found empty prompt content'
        );
      });

      it('should throw error for empty variable content', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = \`\`;

export default prompt;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        await expect(loadPrompt('test.prompt')).rejects.toThrow(
          'loadPrompt() found empty prompt content'
        );
      });

      it('should return null for filesystem read errors', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockRejectedValueOnce(new Error('Permission denied'));

        const result = await loadPrompt('test.prompt');
        expect(result).toBe(null);
      });

      it('should throw contract violation for malformed file content', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        mockFs.readFile.mockResolvedValueOnce('completely invalid content');

        await expect(loadPrompt('test.prompt')).rejects.toThrow(
          'loadPrompt() could not parse prompt file'
        );
      });
    });

    describe('pattern priority', () => {
      it('should prefer literal template literal over variable export', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = \`Variable content\`;

export default \`Literal content\`;`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Literal content');
      });

      it('should prefer literal double quotes over variable export', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = \`Variable content\`;

export default "Literal double quotes";`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Literal double quotes');
      });

      it('should prefer literal single quotes over variable export', async () => {
        mockFs.access.mockResolvedValueOnce(undefined);
        const content = `const prompt = \`Variable content\`;

export default 'Literal single quotes';`;
        mockFs.readFile.mockResolvedValueOnce(content);

        const result = await loadPrompt('test.prompt');
        expect(result).toBe('Literal single quotes');
      });
    });
  });
});
