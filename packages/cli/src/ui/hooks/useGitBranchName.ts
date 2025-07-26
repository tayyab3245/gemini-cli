/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'path';

export function useGitBranchName(cwd: string): string | undefined {
  const [branchName, setBranchName] = useState<string | undefined>(undefined);

  const fetchBranchName = useCallback(
    () =>
      exec(
        'git rev-parse --abbrev-ref HEAD',
        { cwd },
        (error, stdout, _stderr) => {
          if (error) {
            setBranchName(undefined);
            return;
          }
          const branch = stdout.toString().trim();
          if (branch && branch !== 'HEAD') {
            setBranchName(branch);
          } else {
            exec(
              'git rev-parse --short HEAD',
              { cwd },
              (error, stdout, _stderr) => {
                if (error) {
                  setBranchName(undefined);
                  return;
                }
                setBranchName(stdout.toString().trim());
              },
            );
          }
        },
      ),
    [cwd, setBranchName],
  );

  useEffect(() => {
    fetchBranchName(); // Initial fetch

    const gitHeadPath = path.join(cwd, '.git', 'HEAD');
    let watcher: fs.FSWatcher | undefined;

    // Set up file watcher for .git/HEAD changes
    try {
      watcher = fs.watch(gitHeadPath, (eventType: string) => {
        // Changes to .git/HEAD indicate branch switch or HEAD change
        if (eventType === 'change' || eventType === 'rename') {
          fetchBranchName();
        }
      });
    } catch (_watchError) {
      // Silently ignore watcher errors (e.g. permissions, file not existing, or memfs limitations)
      // The branch name will simply not update automatically.
    }

    return () => {
      if (watcher) {
        watcher.close();
        watcher = undefined;
      }
    };
  }, [cwd, fetchBranchName]);

  return branchName;
}
