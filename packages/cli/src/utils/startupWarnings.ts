/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, readFile, unlink } from 'fs/promises';
import os from 'os';
import { join as pathJoin } from 'node:path';
import { getErrorMessage } from '@google/gemini-cli-core';

const warningsFilePath = pathJoin(os.tmpdir(), 'gemini-cli-warnings.txt');

export async function getStartupWarnings(): Promise<string[]> {
  try {
    // Check if file exists first
    await access(warningsFilePath);
    
    // File exists, read it
    const warningsContent = await readFile(warningsFilePath, 'utf-8');
    const warnings = warningsContent
      .split('\n')
      .filter((line) => line.trim() !== '');
    
    // Try to delete the file after reading
    try {
      await unlink(warningsFilePath);
    } catch {
      warnings.push('Warning: Could not delete temporary warnings file.');
    }
    return warnings;
  } catch (err: unknown) {
    // fs.access failed - check if it's because file doesn't exist
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return []; // File not found, no warnings to return.
    }
    // For other access errors (permissions, etc.), return the error message.
    return [`Error checking/reading warnings file: ${getErrorMessage(err)}`];
  }
}
