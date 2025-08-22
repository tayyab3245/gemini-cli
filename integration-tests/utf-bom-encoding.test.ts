/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TestRig, printDebugInfo } from './test-helper.js';
import { writeFileSync } from 'node:fs';

// BOM builders
const utf8BOM = (s: string) =>
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]);
const utf16LE = (s: string) =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16BE = (s: string) => {
  const bom = Buffer.from([0xfe, 0xff]);
  const le = Buffer.from(s, 'utf16le');
  le.swap16();
  return Buffer.concat([bom, le]);
};
const utf32LE = (s: string) => {
  const bom = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
  const cps = Array.from(s, (ch) => ch.codePointAt(0)!).filter(
    (cp) => cp !== undefined,
  );
  const payload = Buffer.alloc(cps.length * 4);
  cps.forEach((cp, i) => {
    const o = i * 4;
    payload[o] = cp & 0xff;
    payload[o + 1] = (cp >>> 8) & 0xff;
    payload[o + 2] = (cp >>> 16) & 0xff;
    payload[o + 3] = (cp >>> 24) & 0xff;
  });
  return Buffer.concat([bom, payload]);
};
const utf32BE = (s: string) => {
  const bom = Buffer.from([0x00, 0x00, 0xfe, 0xff]);
  const cps = Array.from(s, (ch) => ch.codePointAt(0)!).filter(
    (cp) => cp !== undefined,
  );
  const payload = Buffer.alloc(cps.length * 4);
  cps.forEach((cp, i) => {
    const o = i * 4;
    payload[o] = (cp >>> 24) & 0xff;
    payload[o + 1] = (cp >>> 16) & 0xff;
    payload[o + 2] = (cp >>> 8) & 0xff;
    payload[o + 3] = cp & 0xff;
  });
  return Buffer.concat([bom, payload]);
};

const fakePng = () =>
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

async function runCase(
  label: string,
  filename: string,
  buf: Buffer,
  expectText: string,
  shouldSkipBinary: boolean,
) {
  const rig = new TestRig();
  await rig.setup(label);
  try {
    const filePath = rig.createFile(filename, '');
    writeFileSync(filePath, buf);

    const prompt = `read the file ${filename} and show me its exact contents`;
    const result = await rig.run(prompt);
    const foundToolCall = await rig.waitForToolCall('read_file');

    // Flexible success criteria for binary skip: the tool path may yield either the internal
    // returnDisplay ("Skipped binary file:") or the model may emit a refusal phrase such as
    // "I cannot display the content(s) of the binary file". Accept either to avoid brittle
    // coupling to wording while still validating correct classification.
    const lower = result.toLowerCase();
    const binaryIndicators = [
      'skipped binary file',
      // Variants the model may use when declining to show binary data:
      'cannot display the content of the binary file',
      'cannot display the contents of the binary file',
      'cannot display the content of a binary file',
      'cannot display the contents of a binary file',
    ];
    const sawBinaryIndicator = binaryIndicators.some((p) => lower.includes(p));

    if (
      !foundToolCall ||
      (shouldSkipBinary && !sawBinaryIndicator) ||
      (!shouldSkipBinary && !result.includes(expectText))
    ) {
      printDebugInfo(rig, result, {
        label,
        filename,
        foundToolCall,
        shouldSkipBinary,
        includesSkipped: sawBinaryIndicator,
        includesExpectedText: result.includes(expectText),
        snippet: result.slice(0, 180),
      });
    }

    assert.ok(foundToolCall, 'Expected read_file tool call');
    if (shouldSkipBinary) {
      assert.ok(sawBinaryIndicator, 'Expected binary skip indication');
    } else {
      assert.ok(
        !sawBinaryIndicator,
        'Should not have been skipped / hidden as binary',
      );
      assert.ok(
        result.includes(expectText),
        'Decoded content missing expected text',
      );
    }
  } finally {
    await rig.cleanup();
  }
}

// Individual tests
test('UTF-8 BOM text', () =>
  runCase(
    'utf8 bom',
    'utf8-bom.txt',
    utf8BOM('BOM_OK UTF-8'),
    'BOM_OK UTF-8',
    false,
  ));

test('UTF-16 LE BOM text', () =>
  runCase(
    'utf16 le bom',
    'utf16le.txt',
    utf16LE('BOM_OK UTF-16LE'),
    'BOM_OK UTF-16LE',
    false,
  ));

test('UTF-16 BE BOM text', () =>
  runCase(
    'utf16 be bom',
    'utf16be.txt',
    utf16BE('BOM_OK UTF-16BE'),
    'BOM_OK UTF-16BE',
    false,
  ));

test('UTF-32 LE BOM text', () =>
  runCase(
    'utf32 le bom',
    'utf32le.txt',
    utf32LE('BOM_OK UTF-32LE'),
    'BOM_OK UTF-32LE',
    false,
  ));

test('UTF-32 BE BOM text', () =>
  runCase(
    'utf32 be bom',
    'utf32be.txt',
    utf32BE('BOM_OK UTF-32BE'),
    'BOM_OK UTF-32BE',
    false,
  ));

test('Binary PNG control skipped', () =>
  runCase('binary png control', 'control.bin', fakePng(), '', true));
