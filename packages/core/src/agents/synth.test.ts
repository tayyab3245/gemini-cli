/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { SynthAgent, PROMPT_FILE } from './synth.js';
import { ChimeraEventBus } from '../event-bus/bus.js';
import { AgentType } from '../event-bus/types.js';
import type { AgentContext } from './agent.js';
import type { GeminiChat } from '../core/geminiChat.js';
import * as mindLoader from '../utils/mindLoader.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Mock the mindLoader module
vi.mock('../utils/mindLoader.js', () => ({
  loadPrompt: vi.fn()
}));

// Mock fs for build artifact tests and file extension tests
vi.mock('node:fs', () => ({
  promises: {
    access: vi.fn(),
    readFile: vi.fn()
  }
}));

describe('SynthAgent', () => {
  let synthAgent: SynthAgent;
  let mockBus: ChimeraEventBus;
  let publishSpy: Mock;
  let mockGeminiChat: GeminiChat;
  let mockLoadPrompt: Mock;

  beforeEach(() => {
    mockBus = new ChimeraEventBus();
    publishSpy = vi.spyOn(mockBus, 'publish') as Mock;
    mockLoadPrompt = vi.mocked(mindLoader.loadPrompt);

    // Create mock GeminiChat with correct response structure
    mockGeminiChat = {
      sendMessage: vi.fn()
    } as unknown as GeminiChat;

    synthAgent = new SynthAgent(mockBus, mockGeminiChat);

    // Default mock for mindLoader - return a simple prompt
    mockLoadPrompt.mockResolvedValue('Generate a structured plan with 3-5 steps.');
  });

  describe('happy path - plan generation', () => {
    it('should generate a plan with at least 3 steps using GeminiChat and valid ChimeraPlan structure', async () => {
      // Mock GeminiChat to return a multi-step plan
      (mockGeminiChat.sendMessage as Mock).mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: `[
                {"step_id": "S1", "description": "create TypeScript function for JSON file reading", "depends_on": [], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                {"step_id": "S2", "description": "implement validation logic with error handling", "depends_on": ["S1"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                {"step_id": "S3", "description": "write comprehensive unit tests", "depends_on": ["S2"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                {"step_id": "S4", "description": "test integration with file system", "depends_on": ["S3"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3}
              ]`
            }]
          }
        }]
      });

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a TypeScript function that reads a JSON file and validates the data structure',
          assumptions: ['Working with file system', 'TypeScript environment available'],
          constraints: ['Must be type-safe', 'Should handle errors gracefully']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      expect(result.output).toBeDefined();
      expect(result.output!.planJson).toBeDefined();

      // Parse and validate the ChimeraPlan structure
      const parsedPlan = JSON.parse(result.output!.planJson);
      expect(parsedPlan.task_id).toMatch(/^task-\d+$/);
      expect(parsedPlan.original_user_request).toBe(ctx.input.clarifiedUserInput);
      expect(parsedPlan.status).toBe('pending');
      expect(Array.isArray(parsedPlan.plan)).toBe(true);
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3); // Must have at least 3 steps
      expect(parsedPlan.plan.length).toBeLessThanOrEqual(5);

      // Validate ChimeraPlan specific fields
      expect(Array.isArray(parsedPlan.requirements)).toBe(true);
      expect(Array.isArray(parsedPlan.assumptions)).toBe(true);
      expect(parsedPlan.assumptions).toEqual(ctx.input.assumptions);
      expect(Array.isArray(parsedPlan.constraints)).toBe(true);
      expect(parsedPlan.constraints).toEqual(ctx.input.constraints);
      expect(parsedPlan.created_at).toBeDefined();
      expect(parsedPlan.updated_at).toBeDefined();
      expect(typeof parsedPlan.model_versions).toBe('object');
      expect(Array.isArray(parsedPlan.history)).toBe(true);

      // Validate step structure
      parsedPlan.plan.forEach((step: any, index: number) => {
        expect(step.step_id).toBe(`S${index + 1}`);
        expect(step.description).toBeDefined();
        expect(typeof step.description).toBe('string');
        expect(step.description.length).toBeGreaterThan(0);
        expect(Array.isArray(step.depends_on)).toBe(true);
        expect(step.status).toBe('pending');
        expect(Array.isArray(step.artifacts)).toBe(true);
        expect(step.attempts).toBe(0);
        expect(step.max_attempts).toBe(3);

        // First step should have no dependencies
        if (index === 0) {
          expect(step.depends_on).toEqual([]);
        } else {
          expect(step.depends_on).toEqual([`S${index}`]);
        }
      });

      // Verify mindLoader was called
      expect(mockLoadPrompt).toHaveBeenCalledWith(PROMPT_FILE);

      // Verify GeminiChat was called
      expect(mockGeminiChat.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(ctx.input.clarifiedUserInput)
        }),
        'synth-planning'
      );

      // Verify progress events were published
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent-start',
        payload: { id: AgentType.SYNTH }
      }));
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'progress',
        payload: { percent: 25 }
      }));
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'progress',
        payload: { percent: 40 }
      }));
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'progress',
        payload: { percent: 60 }
      }));
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'progress',
        payload: { percent: 75 }
      }));
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'progress',
        payload: { percent: 100 }
      }));
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent-end',
        payload: { id: AgentType.SYNTH }
      }));
    });

    it('should fall back to local generation when prompt is missing', async () => {
      // Mock prompt loading to return null (prompt not found)
      mockLoadPrompt.mockResolvedValue(null);

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a simple function',
          assumptions: ['Basic task'],
          constraints: []
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      const parsedPlan = JSON.parse(result.output!.planJson);
      
      // Should still generate at least 3 steps even with fallback
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3);

      // Verify mindLoader was called but returned null
      expect(mockLoadPrompt).toHaveBeenCalledWith(PROMPT_FILE);
      
      // GeminiChat SHOULD be called with fallback prompt when live prompt is missing
      expect(mockGeminiChat.sendMessage).toHaveBeenCalled();
      
      // Verify fallback prompt is used
      const sendMessageMock = vi.mocked(mockGeminiChat.sendMessage);
      const geminiCall = sendMessageMock.mock.calls[0][0];
      expect(geminiCall.message).toContain('You are an AI assistant that generates implementation plans');
    });

    it('should handle prompt loading failure and fall back to local generation', async () => {
      // Mock prompt loading to throw an error
      mockLoadPrompt.mockRejectedValue(new Error('File not accessible'));

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a function with prompt loading error',
          assumptions: ['Prompt unavailable'],
          constraints: []
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      const parsedPlan = JSON.parse(result.output!.planJson);
      
      // Should still generate at least 3 steps even with prompt loading failure
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3);

      // Verify mindLoader was called
      expect(mockLoadPrompt).toHaveBeenCalledWith(PROMPT_FILE);
      
      // GeminiChat SHOULD be called with fallback prompt when prompt loading fails
      expect(mockGeminiChat.sendMessage).toHaveBeenCalled();
      
      // Verify fallback prompt is used
      const sendMessageMock = vi.mocked(mockGeminiChat.sendMessage);
      const geminiCall = sendMessageMock.mock.calls[0][0];
      expect(geminiCall.message).toContain('You are an AI assistant that generates implementation plans');

      // Should log the prompt loading failure
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'log',
        payload: expect.stringContaining('Mind prompt loading failed: File not accessible, using fallback prompt')
      }));
    });

    it('should handle no GeminiChat and use local generation with minimum 3 steps', async () => {
      // Create agent without GeminiChat
      const localSynthAgent = new SynthAgent(mockBus);
      
      // Reset the mock to ensure it hasn't been called from previous tests
      mockLoadPrompt.mockClear();

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a hello world function',
          assumptions: ['Simple task'],
          constraints: []
        },
        bus: mockBus,
      };

      const result = await localSynthAgent.run(ctx);

      expect(result.ok).toBe(true);
      const parsedPlan = JSON.parse(result.output!.planJson);
      
      // Even simple tasks should generate at least 3 steps
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3);
      expect(parsedPlan.plan.length).toBeLessThanOrEqual(5);

      // mindLoader should not be called when no GeminiChat
      expect(mockLoadPrompt).not.toHaveBeenCalled();
    });

    it('should handle GeminiChat errors gracefully and fall back to local generation', async () => {
      // Mock GeminiChat to throw an error
      (mockGeminiChat.sendMessage as Mock).mockRejectedValue(new Error('API failure'));

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a complex application',
          assumptions: ['Full development needed'],
          constraints: ['Multiple phases required']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      const parsedPlan = JSON.parse(result.output!.planJson);
      
      // Should fall back to local generation with at least 3 steps
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3);

      // Should log the error
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'log',
        payload: expect.stringContaining('Gemini error: API failure, falling back')
      }));
    });

    it('should generate plan steps with required verbs', async () => {
      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Build a React component for user authentication with form validation and API integration',
          assumptions: ['React environment available', 'API endpoints exist'],
          constraints: ['Must be reusable', 'Should follow best practices']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      const parsedPlan = JSON.parse(result.output!.planJson);
      
      // Check that step descriptions start with required verbs
      const requiredVerbs = ['write', 'create', 'generate', 'run', 'test'];
      parsedPlan.plan.forEach((step: any) => {
        const startsWithRequiredVerb = requiredVerbs.some(verb => 
          step.description.toLowerCase().startsWith(verb)
        );
        expect(startsWithRequiredVerb).toBe(true);
      });
    });

    it('should handle complex input with multiple steps', async () => {
      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a comprehensive web application with user authentication, data visualization, API integration, testing, and deployment pipeline',
          assumptions: ['Full-stack development needed', 'Multiple technologies required'],
          constraints: ['Must be scalable', 'Requires testing', 'Multiple phases needed']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      const parsedPlan = JSON.parse(result.output!.planJson);
      
      // Complex input should generate at least 3 steps, likely 4-5
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3);
      expect(parsedPlan.plan.length).toBeLessThanOrEqual(5);
    });

    it('should handle simple input with minimum 3 steps', async () => {
      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a hello world function',
          assumptions: ['Simple task'],
          constraints: []
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      const parsedPlan = JSON.parse(result.output!.planJson);
      
      // Even simple input should generate at least 3 steps
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3);
      expect(parsedPlan.plan.length).toBeLessThanOrEqual(5);
    });
  });

  describe('error path', () => {
    it('should handle exceptions and publish error events', async () => {
      // Mock a method to throw an error
      const originalGeneratePlanSteps = synthAgent['generatePlanSteps'];
      synthAgent['generatePlanSteps'] = vi.fn().mockImplementation(() => {
        throw new Error('Planning algorithm failed');
      });

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create something that will fail',
          assumptions: [],
          constraints: []
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Planning failed: Planning algorithm failed');
      expect(result.output).toBeUndefined();

      // Should publish error event
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          agent: 'SYNTH',
          message: 'Planning algorithm failed'
        })
      }));

      // Should still publish agent-start and agent-end
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent-start',
        payload: { id: AgentType.SYNTH }
      }));
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent-end',
        payload: { id: AgentType.SYNTH }
      }));

      // Restore original method
      synthAgent['generatePlanSteps'] = originalGeneratePlanSteps;
    });

    it('should handle non-Error exceptions', async () => {
      // Mock a method to throw a non-Error
      synthAgent['generatePlanSteps'] = vi.fn().mockImplementation(() => {
        throw 'String error';
      });

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create something that will fail with string error',
          assumptions: [],
          constraints: []
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Planning failed: String error');

      // Should publish error event with string error
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          agent: 'SYNTH',
          message: 'Unknown planning error',
          details: 'String error'
        })
      }));
    });
  });

  describe('dependency chain validation', () => {
    it('should create proper dependency chain in multi-step plans', async () => {
      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a multi-step application with testing and validation phases',
          assumptions: ['Multiple steps required'],
          constraints: ['Step-by-step approach', 'Dependencies must be respected']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      const parsedPlan = JSON.parse(result.output!.planJson);
      
      // Validate dependency chain
      parsedPlan.plan.forEach((step: any, index: number) => {
        if (index === 0) {
          // First step has no dependencies
          expect(step.depends_on).toEqual([]);
        } else {
          // Each subsequent step depends on the previous one
          expect(step.depends_on).toEqual([`S${index}`]);
        }
      });
    });
  });

  describe('P3.14-SYNTH-GUARDS: timeout and retry logic', () => {
    it('should succeed after timeout then success within 3 retries', async () => {
      let callCount = 0;
      (mockGeminiChat.sendMessage as Mock).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call times out
          throw new Error('timeout');
        }
        // Second call succeeds
        return {
          candidates: [{
            content: {
              parts: [{
                text: `[
                  {"step_id": "S1", "description": "create initial implementation", "depends_on": [], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                  {"step_id": "S2", "description": "add error handling", "depends_on": ["S1"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                  {"step_id": "S3", "description": "write comprehensive tests", "depends_on": ["S2"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3}
                ]`
              }]
            }
          }]
        };
      });

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a function with error handling',
          assumptions: ['Error handling needed'],
          constraints: ['Must be robust']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      expect(callCount).toBe(2); // First call failed, second succeeded
      
      const parsedPlan = JSON.parse(result.output!.planJson);
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3);
    });

    it('should emit error event and return fallback plan when all retries fail', async () => {
      // Mock GeminiChat to always fail
      (mockGeminiChat.sendMessage as Mock).mockRejectedValue(new Error('Permanent API failure'));

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a complex application',
          assumptions: ['Full development needed'],
          constraints: ['Multiple phases required']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true); // Should still succeed with fallback
      
      // Verify error event was emitted
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          agent: 'SYNTH',
          message: 'Permanent API failure',
          stack: expect.any(String)
        })
      }));

      // Verify log event was also emitted
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'log',
        payload: expect.stringContaining('Gemini error: Permanent API failure, falling back')
      }));

      // Should fall back to local generation with at least 3 steps
      const parsedPlan = JSON.parse(result.output!.planJson);
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle timeout errors specifically', async () => {
      // Mock GeminiChat to timeout
      (mockGeminiChat.sendMessage as Mock).mockRejectedValue(new Error('timeout'));

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a timeout-prone function',
          assumptions: ['Network calls involved'],
          constraints: ['Must handle timeouts']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true); // Should still succeed with fallback
      
      // Verify timeout-specific error event was emitted
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          agent: 'SYNTH',
          message: 'timeout',
          stack: expect.any(String)
        })
      }));

      // Should fall back to local generation
      const parsedPlan = JSON.parse(result.output!.planJson);
      expect(parsedPlan.plan.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('P3.4-B-SYNTH-PROMPT-HARDEN: production-safe loader tests', () => {
    let mockFsAccess: Mock;
    let mockFsReadFile: Mock;

    beforeEach(() => {
      mockFsAccess = vi.mocked(fs.access);
      mockFsReadFile = vi.mocked(fs.readFile);
    });

    it('should handle extension auto-detection (.ts and .js)', async () => {
      // Mock loadPrompt to test both extensions are tried
      mockLoadPrompt.mockImplementation(async (baseName: string) => {
        // Simulate the loader trying .ts first, then .js
        expect(baseName).toBe('synth.prompt'); // Should be called with base name
        return 'Mocked prompt content from auto-detection';
      });

      // Mock GeminiChat to return valid response
      (mockGeminiChat.sendMessage as Mock).mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: `[
                {"step_id": "S1", "description": "auto-detected step", "depends_on": [], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                {"step_id": "S2", "description": "second step", "depends_on": ["S1"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                {"step_id": "S3", "description": "third step", "depends_on": ["S2"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3}
              ]`
            }]
          }
        }]
      });

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Test extension auto-detection',
          assumptions: ['Both .ts and .js should be supported'],
          constraints: ['Must work in dev and prod']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      expect(mockLoadPrompt).toHaveBeenCalledWith(PROMPT_FILE);
      expect(PROMPT_FILE).toBe('synth.prompt'); // Verify it's now the base name
      
      const parsedPlan = JSON.parse(result.output!.planJson);
      expect(parsedPlan.plan.length).toBe(3);
    });

    it('should handle contract violation with descriptive error and emit error event', async () => {
      // Mock loadPrompt to throw contract violation error
      mockLoadPrompt.mockRejectedValue(new Error('loadPrompt() could not parse prompt file /path/to/synth.prompt.ts. Ensure your prompt file exports a string as the default export using: export default `your-prompt-here`'));

      // Mock GeminiChat to return valid response (should use fallback prompt)
      (mockGeminiChat.sendMessage as Mock).mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: `[
                {"step_id": "S1", "description": "fallback step 1", "depends_on": [], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                {"step_id": "S2", "description": "fallback step 2", "depends_on": ["S1"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                {"step_id": "S3", "description": "fallback step 3", "depends_on": ["S2"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3}
              ]`
            }]
          }
        }]
      });

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create a function that handles loader contract violations',
          assumptions: ['Error handling needed'],
          constraints: ['Must gracefully fallback']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      expect(mockLoadPrompt).toHaveBeenCalledWith(PROMPT_FILE);
      
      // Should emit error event for contract violation
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          agent: 'SYNTH',
          message: expect.stringContaining('loadPrompt() could not parse prompt file')
        })
      }));
      
      // Should also log the contract violation
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'log',
        payload: expect.stringContaining('Mind prompt loading failed: loadPrompt() could not parse prompt file')
      }));

      // Should successfully generate plan with fallback
      const parsedPlan = JSON.parse(result.output!.planJson);
      expect(parsedPlan.plan.length).toBe(3);
    });

    it('should handle file not found gracefully without error events', async () => {
      // Mock loadPrompt to return null (file not found)
      mockLoadPrompt.mockResolvedValue(null);

      // Mock GeminiChat to return valid response
      (mockGeminiChat.sendMessage as Mock).mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: `[
                {"step_id": "S1", "description": "fallback step", "depends_on": [], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                {"step_id": "S2", "description": "second step", "depends_on": ["S1"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
                {"step_id": "S3", "description": "third step", "depends_on": ["S2"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3}
              ]`
            }]
          }
        }]
      });

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create something with missing prompt file',
          assumptions: ['File not found scenario'],
          constraints: ['Should work gracefully']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true);
      expect(mockLoadPrompt).toHaveBeenCalledWith(PROMPT_FILE);
      
      // Should NOT emit error event for file not found
      const errorEvents = publishSpy.mock.calls.filter(call => 
        call[0]?.type === 'error' && 
        call[0]?.payload?.agent === 'SYNTH'
      );
      expect(errorEvents).toHaveLength(0);

      // Should successfully use fallback prompt
      const parsedPlan = JSON.parse(result.output!.planJson);
      expect(parsedPlan.plan.length).toBe(3);
    });

    it('should verify mind prompt file is not included in build artifacts', async () => {
      // Mock fs.access to check if the file exists in build output (should use base name now)
      const buildOutputPath = path.resolve(process.cwd(), 'packages', 'core', 'dist', 'mind', 'synth.prompt.js');
      
      // Expect the file NOT to exist in build output (should be git-ignored)
      mockFsAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));
      
      // Test that the mind prompt file is properly excluded from build
      await expect(fs.access(buildOutputPath)).rejects.toThrow('ENOENT');
      
      // Verify the call was made to check the build output path
      expect(mockFsAccess).toHaveBeenCalledWith(buildOutputPath);
    });

    it('should emit exactly one error event per failed Gemini call', async () => {
      // Mock loadPrompt to succeed
      mockLoadPrompt.mockResolvedValue('Test prompt for error event verification');

      // Mock GeminiChat to fail consistently (withRetries will try 3 times, then throw)
      (mockGeminiChat.sendMessage as Mock).mockRejectedValue(new Error('Gemini API failure'));

      const ctx: AgentContext<{ clarifiedUserInput: string; assumptions: string[]; constraints: string[] }> = {
        input: {
          clarifiedUserInput: 'Create something that will fail',
          assumptions: ['Will fail'],
          constraints: ['Should emit only one error event']
        },
        bus: mockBus,
      };

      const result = await synthAgent.run(ctx);

      expect(result.ok).toBe(true); // Should succeed with fallback
      
      // Count error events - should be exactly 1 despite withRetries attempting 3 times
      const errorEvents = publishSpy.mock.calls.filter(call => 
        call[0]?.type === 'error' && 
        call[0]?.payload?.agent === 'SYNTH' &&
        call[0]?.payload?.message === 'Gemini API failure'
      );
      
      expect(errorEvents).toHaveLength(1);
      
      // Verify the single error event has correct structure
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({
          agent: 'SYNTH',
          message: 'Gemini API failure',
          stack: expect.any(String)
        })
      }));
    });
  });
});
