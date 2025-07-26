/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStartupWarnings } from './startupWarnings.js';
import { access, readFile, unlink } from 'fs/promises';
import { getErrorMessage } from '@google/gemini-cli-core';

vi.mock('fs/promises');
vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as Record<string, unknown>,
    getErrorMessage: vi.fn(),
  };
});

describe('startupWarnings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return warnings from the file and delete it', async () => {
    const mockWarnings = 'Warning 1\nWarning 2';
    vi.mocked(access).mockResolvedValue();
    vi.mocked(readFile).mockResolvedValue(mockWarnings);
    vi.mocked(unlink).mockResolvedValue();

    const warnings = await getStartupWarnings();

    expect(access).toHaveBeenCalled();
    expect(readFile).toHaveBeenCalled();
    expect(unlink).toHaveBeenCalled();
    expect(warnings).toEqual(['Warning 1', 'Warning 2']);
  });

  it('should return an empty array if the file does not exist', async () => {
    const error = new Error('File not found');
    (error as Error & { code: string }).code = 'ENOENT';
    vi.mocked(access).mockRejectedValue(error);

    const warnings = await getStartupWarnings();

    expect(warnings).toEqual([]);
  });

  it('should return an error message if reading the file fails', async () => {
    const error = new Error('Permission denied');
    vi.mocked(access).mockRejectedValue(error);
    vi.mocked(getErrorMessage).mockReturnValue('Permission denied');

    const warnings = await getStartupWarnings();

    expect(warnings).toEqual([
      'Error checking/reading warnings file: Permission denied',
    ]);
  });

  it('should return a warning if deleting the file fails', async () => {
    const mockWarnings = 'Warning 1';
    vi.mocked(access).mockResolvedValue();
    vi.mocked(readFile).mockResolvedValue(mockWarnings);
    vi.mocked(unlink).mockRejectedValue(new Error('Permission denied'));

    const warnings = await getStartupWarnings();

    expect(warnings).toEqual([
      'Warning 1',
      'Warning: Could not delete temporary warnings file.',
    ]);
  });
});
