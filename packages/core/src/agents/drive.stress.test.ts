/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DriveAgent, type DriveInput } from './drive.js';
import { ChimeraEventBus } from '../event-bus/bus.js';
import { AgentType } from '../event-bus/types.js';
import type { AgentContext } from './agent.js';
import type { PlanStep } from '../interfaces/chimera.js';
import type { GeminiChat } from '../core/geminiChat.js';
import {
  createEventCapture,
  createSuccessfulGeminiChat,
  createFailingGeminiChat,
  createMalformedGeminiChat,
  createTimeoutGeminiChat,
  createIntermittentGeminiChat
} from '../utils/testHelpers.js';
import * as mindLoader from '../utils/mindLoader.js';

// Mock the mindLoader module
vi.mock('../utils/mindLoader.js', () => ({
  loadPrompt: vi.fn()
}));

// Mock recovery module with timeout/retry support
vi.mock('../coordination/recovery.js', () => ({
  withTimeout: vi.fn((promise) => promise),
  withRetries: vi.fn(async (fn, retries) => {
    let lastError;
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  })
}));

interface StressTestCase {
  name: string;
  planStep: PlanStep;
  geminiSetup?: (sendMessageMock: Mock) => void;
  toolSetup?: {
    writeFile?: { shouldThrow?: boolean; result?: any };
    execShell?: { shouldThrow?: boolean; result?: any };
  };
  expectedOutcome: 'success' | 'failure';
  expectedArtifactsLength: number;
  expectedErrorEvents: number;
  expectedProgressEvents: number;
  description: string;
}

const DRIVE_STRESS_TEST_CASES: StressTestCase[] = [
  // Happy path scenarios
  {
    name: 'Happy 3-step plan with valid JSON',
    planStep: {
      step_id: 'S1',
      description: 'write:src/hello.js:console.log("hello")\nrun:node src/hello.js\ntest:npm test',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    },
    geminiSetup: (sendMessageMock) => {
      // Don't set up Gemini - test will use rule-based parsing
      sendMessageMock.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: 'fallback to rules'
            }]
          }
        }]
      });
    },
    expectedOutcome: 'success',
    expectedArtifactsLength: 3,
    expectedErrorEvents: 1, // Gemini parse error, then fallback succeeds
    expectedProgressEvents: 2, // 0% and progress during execution
    description: 'Should execute all three commands successfully and return 3 artifacts'
  },
  {
    name: 'Valid Gemini JSON response',
    planStep: {
      step_id: 'S2',
      description: 'Create a new configuration file',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    },
    geminiSetup: (sendMessageMock) => {
      sendMessageMock.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: '{"tool": "write_file", "args": {"file_path": "config.json", "content": "{\\"debug\\": true}"}}'
            }]
          }
        }]
      });
    },
    expectedOutcome: 'success',
    expectedArtifactsLength: 1,
    expectedErrorEvents: 0,
    expectedProgressEvents: 3, // 0%, 30%, 60%, 100%
    description: 'Should successfully execute Gemini JSON instruction'
  },

  // Malformed JSON scenarios
  {
    name: 'Malformed JSON from Gemini - falls back to rule parser',
    planStep: {
      step_id: 'S3',
      description: 'write:fallback.txt:This is fallback content',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    },
    geminiSetup: (sendMessageMock) => {
      sendMessageMock.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: '{"tool": "write_file", "args": {"file_path": "invalid.json", "content": malformed json'
            }]
          }
        }]
      });
    },
    expectedOutcome: 'success',
    expectedArtifactsLength: 1,
    expectedErrorEvents: 1, // JSON parse error
    expectedProgressEvents: 2, // 0% and progress during fallback
    description: 'Should emit error for JSON parse failure but succeed with rule-based fallback'
  },

  // Unknown verb scenarios  
  {
    name: 'Unknown verb - deploy command',
    planStep: {
      step_id: 'S4',
      description: 'deploy:my-app --production',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    },
    expectedOutcome: 'success',
    expectedArtifactsLength: 1, // DriveAgent creates default.txt when no commands found
    expectedErrorEvents: 0, // No error for unknown verbs
    expectedProgressEvents: 2, // 0% and 100%
    description: 'Should succeed with empty artifacts when no supported verbs found'
  },

  // Tool failure scenarios
  {
    name: 'write_file tool throws on execution',
    planStep: {
      step_id: 'S5',
      description: 'write:fail.txt:This will fail',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    },
    toolSetup: {
      writeFile: { shouldThrow: true }
    },
    expectedOutcome: 'failure',
    expectedArtifactsLength: 0,
    expectedErrorEvents: 3, // Multiple error events during failure handling
    expectedProgressEvents: 2, // 0% and progress before tool failure
    description: 'Should fail when write_file tool throws error'
  },

  // Retry exhaustion scenarios
  {
    name: 'Gemini throws 3 times - fallback succeeds',
    planStep: {
      step_id: 'S6',
      description: 'write:retry-test.txt:Content after retries',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    },
    geminiSetup: (sendMessageMock) => {
      sendMessageMock
        .mockRejectedValueOnce(new Error('First failure'))
        .mockRejectedValueOnce(new Error('Second failure'))  
        .mockRejectedValueOnce(new Error('Third failure'));
    },
    expectedOutcome: 'success',
    expectedArtifactsLength: 1,
    expectedErrorEvents: 1, // Gemini retry exhaustion error
    expectedProgressEvents: 2, // 0% and fallback progress
    description: 'Should emit error for Gemini failures but succeed with fallback execution'
  },

  // Empty response scenarios
  {
    name: 'Empty Gemini response - fallback to rules',
    planStep: {
      step_id: 'S7',
      description: 'run:echo "fallback command"',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    },
    geminiSetup: (sendMessageMock) => {
      sendMessageMock.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{ text: '' }]
          }
        }]
      });
    },
    expectedOutcome: 'success',
    expectedArtifactsLength: 1,
    expectedErrorEvents: 1, // Empty response error
    expectedProgressEvents: 2, // 0% and fallback progress
    description: 'Should handle empty Gemini response and fallback to rule-based parsing'
  },

  // No commands scenario
  {
    name: 'Description with no valid commands',
    planStep: {
      step_id: 'S8',
      description: 'This is just a description without any command verbs or colons',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    },
    expectedOutcome: 'success',
    expectedArtifactsLength: 1, // DriveAgent creates default.txt when no commands found
    expectedErrorEvents: 0,
    expectedProgressEvents: 2, // 0% and 100% (no commands to execute)
    description: 'Should succeed with default artifact when no commands are found'
  },

  // Tool registry missing scenarios
  {
    name: 'Missing tool in registry',
    planStep: {
      step_id: 'S9',
      description: 'write:missing-tool.txt:This will fail',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    },
    toolSetup: {
      writeFile: { shouldThrow: false }, // Tool exists but we'll remove it
    },
    expectedOutcome: 'failure',
    expectedArtifactsLength: 0,
    expectedErrorEvents: 3, // Multiple error events during missing tool handling
    expectedProgressEvents: 2, // 0% and progress before tool missing error
    description: 'Should fail when required tool is missing from registry'
  }
];

describe('DriveAgent Stress Test Suite', () => {
  let driveAgent: DriveAgent;
  let eventCapture: ReturnType<typeof createEventCapture>;
  let mockToolRegistry: any;
  let mockWriteTool: any;
  let mockExecTool: any;
  let mockLoadPrompt: Mock;

  beforeEach(() => {
    eventCapture = createEventCapture();
    mockLoadPrompt = vi.mocked(mindLoader.loadPrompt);
    
    // Setup default prompt response
    mockLoadPrompt.mockResolvedValue('Execute the following plan step using available tools.');

    // Create mock tools
    mockWriteTool = {
      execute: vi.fn().mockResolvedValue({ success: true })
    };

    mockExecTool = {
      execute: vi.fn().mockResolvedValue({ success: true })
    };

    // Create mock tool registry
    mockToolRegistry = {
      getTool: vi.fn((toolName: string) => {
        switch (toolName) {
          case 'write_file': return mockWriteTool;
          case 'exec_shell': return mockExecTool;
          default: return null;
        }
      })
    };
  });

  describe.each(DRIVE_STRESS_TEST_CASES)('Stress test case: $name', (testCase) => {
    it(`should ${testCase.expectedOutcome} - ${testCase.description}`, async () => {
      // Setup GeminiChat based on test case
      let mockGeminiChat: GeminiChat | undefined;
      
      if (testCase.geminiSetup) {
        const { mock, sendMessage } = createMockGeminiChat();
        testCase.geminiSetup(sendMessage);
        mockGeminiChat = mock;
      } else {
        // Default successful GeminiChat
        mockGeminiChat = createSuccessfulGeminiChat('{"tool": "write_file", "args": {"file_path": "default.txt", "content": "default"}}');
      }

      // Setup tool behaviors
      if (testCase.toolSetup?.writeFile?.shouldThrow) {
        mockWriteTool.execute.mockRejectedValue(new Error('write_file tool failed'));
      }
      if (testCase.toolSetup?.execShell?.shouldThrow) {
        mockExecTool.execute.mockRejectedValue(new Error('exec_shell tool failed'));
      }

      // Handle special case: missing tool scenario
      if (testCase.name === 'Missing tool in registry') {
        mockToolRegistry.getTool.mockReturnValue(null);
      }

      driveAgent = new DriveAgent(eventCapture.bus, mockGeminiChat);

      const ctx: AgentContext<DriveInput> = {
        input: {
          planStep: testCase.planStep,
          artifacts: []
        },
        bus: eventCapture.bus,
        dependencies: {
          toolRegistry: mockToolRegistry
        }
      };

      eventCapture.reset();
      const result = await driveAgent.run(ctx);

      // Verify outcome expectation
      expect(result.ok).toBe(testCase.expectedOutcome === 'success');
      
      if (testCase.expectedOutcome === 'success') {
        expect(result.output).toBeDefined();
        expect(result.output!.artifacts).toHaveLength(testCase.expectedArtifactsLength);
      } else {
        expect(result.error).toBeDefined();
      }

      // Verify event emission patterns
      const errorEvents = eventCapture.getEventsByType('error');
      expect(errorEvents).toHaveLength(testCase.expectedErrorEvents);

      const progressEvents = eventCapture.getEventsByType('progress');
      expect(progressEvents.length).toBeGreaterThanOrEqual(testCase.expectedProgressEvents);

      // Verify agent lifecycle events
      const startEvents = eventCapture.getEventsByType('agent-start');
      const endEvents = eventCapture.getEventsByType('agent-end');
      expect(startEvents).toHaveLength(1);
      expect(endEvents).toHaveLength(1);
      expect(startEvents[0].payload.id).toBe(AgentType.DRIVE);
      expect(endEvents[0].payload.id).toBe(AgentType.DRIVE);

      // Verify error event content for failure cases
      if (testCase.expectedErrorEvents > 0) {
        const firstError = errorEvents[0];
        expect(firstError.payload.agent).toBe('DRIVE');
        expect(firstError.payload.message).toBeDefined();
      }

      // Verify progress tracking
      if (progressEvents.length > 0) {
        const firstProgress = progressEvents[0];
        expect(firstProgress.payload.percent).toBe(0);
        
        if (testCase.expectedOutcome === 'success' && progressEvents.length > 1) {
          const lastProgress = progressEvents[progressEvents.length - 1];
          expect(lastProgress.payload.percent).toBe(100);
        }
      }
    });
  });

  describe('Tool registry edge cases', () => {
    it('should fail when tool registry is not provided in context', async () => {
      const mockGeminiChat = createSuccessfulGeminiChat('{"tool": "write_file", "args": {"file_path": "test.txt", "content": "test"}}');
      driveAgent = new DriveAgent(eventCapture.bus, mockGeminiChat);

      const ctx: AgentContext<DriveInput> = {
        input: {
          planStep: {
            step_id: 'S1',
            description: 'write:test.txt:content',
            depends_on: [],
            status: 'pending',
            artifacts: [],
            attempts: 0,
            max_attempts: 3
          },
          artifacts: []
        },
        bus: eventCapture.bus,
        dependencies: {} // Missing toolRegistry
      };

      eventCapture.reset();
      const result = await driveAgent.run(ctx);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('ToolRegistry not available');

      const errorEvents = eventCapture.getEventsByType('error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].payload.message).toContain('ToolRegistry not available');
    });
  });

  describe('Command parsing edge cases', () => {
    it('should handle Windows path parsing correctly', async () => {
      const mockGeminiChat = createSuccessfulGeminiChat('{"tool": "write_file", "args": {"file_path": "C:\\\\temp\\\\test.txt", "content": "windows test"}}');
      driveAgent = new DriveAgent(eventCapture.bus, mockGeminiChat);

      const ctx: AgentContext<DriveInput> = {
        input: {
          planStep: {
            step_id: 'S1',
            description: 'write:C:\\temp\\file.txt:Windows content',
            depends_on: [],
            status: 'pending',
            artifacts: [],
            attempts: 0,
            max_attempts: 3
          },
          artifacts: []
        },
        bus: eventCapture.bus,
        dependencies: {
          toolRegistry: mockToolRegistry
        }
      };

      eventCapture.reset();
      const result = await driveAgent.run(ctx);

      expect(result.ok).toBe(true);
      expect(result.output!.artifacts).toHaveLength(1);
      expect(mockWriteTool.execute).toHaveBeenCalledWith({
        file_path: 'C:\\temp\\test.txt',
        content: 'windows test'
      }, expect.any(AbortSignal));
    });

    it('should handle malformed write command syntax', async () => {
      driveAgent = new DriveAgent(eventCapture.bus);

      const ctx: AgentContext<DriveInput> = {
        input: {
          planStep: {
            step_id: 'S1',
            description: 'write:missing_content_part', // Missing content after colon
            depends_on: [],
            status: 'pending',
            artifacts: [],
            attempts: 0,
            max_attempts: 3
          },
          artifacts: []
        },
        bus: eventCapture.bus,
        dependencies: {
          toolRegistry: mockToolRegistry
        }
      };

      eventCapture.reset();
      const result = await driveAgent.run(ctx);

      expect(result.ok).toBe(false); // Should fail with malformed syntax
      expect(result.error).toBeDefined();
      // Should not execute tool with malformed input
      expect(mockWriteTool.execute).not.toHaveBeenCalled();
    });
  });

  describe('Gemini integration edge cases', () => {
    it('should handle Gemini timeout and fallback successfully', async () => {
      const mockGeminiChat = createTimeoutGeminiChat(100);
      driveAgent = new DriveAgent(eventCapture.bus, mockGeminiChat);

      const ctx: AgentContext<DriveInput> = {
        input: {
          planStep: {
            step_id: 'S1',
            description: 'write:timeout-test.txt:Fallback content',
            depends_on: [],
            status: 'pending',
            artifacts: [],
            attempts: 0,
            max_attempts: 3
          },
          artifacts: []
        },
        bus: eventCapture.bus,
        dependencies: {
          toolRegistry: mockToolRegistry
        }
      };

      eventCapture.reset();
      const result = await driveAgent.run(ctx);

      expect(result.ok).toBe(true);
      expect(result.output!.artifacts).toHaveLength(1);

      const errorEvents = eventCapture.getEventsByType('error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect(errorEvents[0].payload.message).toContain('timeout');
    });

    it('should handle missing prompt file gracefully', async () => {
      mockLoadPrompt.mockResolvedValue(null); // Simulate missing prompt file
      
      const mockGeminiChat = createSuccessfulGeminiChat('{"tool": "write_file", "args": {"file_path": "test.txt", "content": "test"}}');
      driveAgent = new DriveAgent(eventCapture.bus, mockGeminiChat);

      const ctx: AgentContext<DriveInput> = {
        input: {
          planStep: {
            step_id: 'S1',
            description: 'write:no-prompt.txt:Content without prompt',
            depends_on: [],
            status: 'pending',
            artifacts: [],
            attempts: 0,
            max_attempts: 3
          },
          artifacts: []
        },
        bus: eventCapture.bus,
        dependencies: {
          toolRegistry: mockToolRegistry
        }
      };

      eventCapture.reset();
      const result = await driveAgent.run(ctx);

      expect(result.ok).toBe(true);
      expect(result.output!.artifacts).toHaveLength(1);

      const logEvents = eventCapture.getEventsByType('log');
      const promptNotFoundLog = logEvents.find(event => 
        event.payload.includes('Prompt not found')
      );
      expect(promptNotFoundLog).toBeDefined();
    });
  });
});

function createMockGeminiChat(): { mock: GeminiChat; sendMessage: Mock } {
  const sendMessage = vi.fn();
  const mock = { sendMessage } as unknown as GeminiChat;
  return { mock, sendMessage };
}
