/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { promises as fs } from 'fs';
import { AuditAgent } from './audit.js';
import { ChimeraEventBus } from '../event-bus/bus.js';
import { AgentType } from '../event-bus/types.js';
import type { ChimeraPlan } from '../interfaces/chimera.js';
import type { GeminiChat } from '../core/geminiChat.js';
import * as mindLoader from '../utils/mindLoader.js';

// Mock the mindLoader module
vi.mock('../utils/mindLoader.js', () => ({
  loadPrompt: vi.fn()
}));

// Mock recovery module
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

// Mock fs.access
vi.mock('fs', () => ({
  promises: {
    access: vi.fn()
  }
}));

describe('AuditAgent', () => {
  let auditAgent: AuditAgent;
  let mockBus: ChimeraEventBus;
  let publishSpy: ReturnType<typeof vi.fn>;
  let mockGeminiChat: GeminiChat;
  let mockLoadPrompt: Mock;

  beforeEach(() => {
    publishSpy = vi.fn();
    mockBus = {
      publish: publishSpy,
      subscribe: vi.fn(),
      history: vi.fn(() => [])
    } as unknown as ChimeraEventBus;
    
    // Create mock GeminiChat
    mockGeminiChat = {
      sendMessage: vi.fn()
    } as unknown as GeminiChat;

    mockLoadPrompt = vi.mocked(mindLoader.loadPrompt);
    
    // Default mock for mindLoader - return a constitution prompt
    mockLoadPrompt.mockResolvedValue('You are an audit agent. Return JSON: {"pass": boolean, "reasons": string[]}');
    
    auditAgent = new AuditAgent(mockBus);
    vi.clearAllMocks();
  });

  const createValidPlan = (): ChimeraPlan => ({
    task_id: 'test-001',
    original_user_request: 'Test request',
    requirements: ['Test requirement'],
    assumptions: [],
    constraints: [],
    plan: [{
      step_id: 'S1',
      description: 'Test step',
      rationale: 'Test rationale',
      tools: [],
      inputs: {},
      depends_on: [],
      status: 'done',
      artifacts: ['test.txt'],
      attempts: 1,
      max_attempts: 3
    }],
    status: 'done',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    model_versions: { architect: 'test' },
    history: []
  });

  const createContext = (input: { planJson: string; artifacts: string[] }) => ({
    input,
    bus: mockBus
  });

  describe('Basic functionality', () => {
    it('should have correct agent ID', () => {
      expect(auditAgent.id).toBe(AgentType.AUDIT);
    });

    it('should publish agent-start and agent-end events', async () => {
      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: []
      });

      // Mock fs.access to succeed (no artifacts to check)
      vi.mocked(fs.access).mockResolvedValue(undefined);

      await auditAgent.run(context);

      // Check for agent-start event
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'agent-start',
        payload: { id: AgentType.AUDIT }
      });

      // Check for agent-end event
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'agent-end',
        payload: { id: AgentType.AUDIT }
      });
    });

    it('should publish progress events at 25%, 50%, 75%, 100%', async () => {
      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: []
      });

      vi.mocked(fs.access).mockResolvedValue(undefined);

      await auditAgent.run(context);

      // Check for progress events
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'progress',
        payload: { percent: 25 }
      });
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'progress',
        payload: { percent: 50 }
      });
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'progress',
        payload: { percent: 75 }
      });
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'progress',
        payload: { percent: 100 }
      });
    });
  });

  describe('Happy path', () => {
    it('should return pass:true for valid plan and existing artifacts', async () => {
      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: ['existing-file.txt', 'another-file.js']
      });

      // Mock fs.access to succeed for all files
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(true);
      expect(result.output?.recommendation).toBeUndefined();

      // Should publish success log
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'log',
        payload: 'AUDIT PASSED: All quality checks successful (rule-based)'
      });
    });

    it('should handle empty artifacts list successfully', async () => {
      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: []
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(true);
      expect(result.output?.recommendation).toBeUndefined();
    });
  });

  describe('Plan JSON validation', () => {
    it('should return pass:false for invalid JSON', async () => {
      const context = createContext({
        planJson: '{ invalid json }',
        artifacts: []
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toContain('planJson is not valid JSON');

      // Should publish failure log
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'log',
        payload: 'AUDIT FAILED: 1 issue(s) found (rule-based)'
      });
    });

    it('should return pass:false for missing required keys', async () => {
      const incompletePlan = {
        task_id: 'test-001'
        // Missing 'plan' and 'status'
      };
      const context = createContext({
        planJson: JSON.stringify(incompletePlan),
        artifacts: []
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toContain('planJson missing required key: "plan"');
      expect(result.output?.recommendation).toContain('planJson missing required key: "status"');
    });

    it('should return pass:false for plan steps with error messages', async () => {
      const planWithErrors = createValidPlan();
      planWithErrors.plan[0].error_message = 'Something went wrong';
      planWithErrors.plan[0].status = 'failed';

      const context = createContext({
        planJson: JSON.stringify(planWithErrors),
        artifacts: []
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toContain('Step 1: status is "failed", expected "done"');
      expect(result.output?.recommendation).toContain('Step 1: contains error message: "Something went wrong"');
    });

    it('should return pass:false for plan steps not marked as done', async () => {
      const planWithPendingSteps = createValidPlan();
      planWithPendingSteps.plan[0].status = 'pending';

      const context = createContext({
        planJson: JSON.stringify(planWithPendingSteps),
        artifacts: []
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toContain('Step 1: status is "pending", expected "done"');
    });

    it('should return pass:false for plan steps missing required fields', async () => {
      const planWithIncompleteSteps = createValidPlan();
      planWithIncompleteSteps.plan[0].step_id = '';
      planWithIncompleteSteps.plan[0].description = '';

      const context = createContext({
        planJson: JSON.stringify(planWithIncompleteSteps),
        artifacts: []
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toContain('Step 1: missing step_id');
      expect(result.output?.recommendation).toContain('Step 1: missing description');
    });
  });

  describe('Artifact validation', () => {
    it('should return pass:false for missing artifact files', async () => {
      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: ['missing-file.txt', 'another-missing.js']
      });

      // Mock fs.access to throw for missing files
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toContain('Artifact 1: file does not exist: "missing-file.txt"');
      expect(result.output?.recommendation).toContain('Artifact 2: file does not exist: "another-missing.js"');
    });

    it('should return pass:false for empty artifact paths', async () => {
      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: ['', '   ', 'valid-file.txt']
      });

      // Mock fs.access to succeed for valid file
      vi.mocked(fs.access).mockImplementation((path) => {
        if (path === 'valid-file.txt') {
          return Promise.resolve(undefined);
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toContain('Artifact 1: path is empty or whitespace');
      expect(result.output?.recommendation).toContain('Artifact 2: path is empty or whitespace');
    });

    it('should handle mixed valid and invalid artifacts', async () => {
      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: ['existing-file.txt', 'missing-file.txt']
      });

      // Mock fs.access - first file exists, second doesn't
      vi.mocked(fs.access).mockImplementation((path) => {
        if (path === 'existing-file.txt') {
          return Promise.resolve(undefined);
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toContain('Artifact 2: file does not exist: "missing-file.txt"');
      expect(result.output?.recommendation).not.toContain('existing-file.txt');
    });
  });

  describe('Error handling', () => {
    it('should handle exceptions gracefully and return internal error', async () => {
      const context = createContext({
        planJson: JSON.stringify(createValidPlan()),
        artifacts: ['test.txt']
      });

      // Spy on JSON.parse to cause an exception in a different way
      const originalParse = JSON.parse;
      vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
        throw new Error('Simulated internal error');
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toBe('internal error');

      // Should publish error event
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'error',
        payload: {
          agent: 'AUDIT',
          message: 'Simulated internal error',
          details: expect.any(String)
        }
      });

      // Restore original
      JSON.parse = originalParse;
    });

    it('should handle non-Error exceptions', async () => {
      const context = createContext({
        planJson: JSON.stringify(createValidPlan()),
        artifacts: []
      });

      // Mock JSON.parse to throw a string
      const originalParse = JSON.parse;
      vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
        throw 'String error';
      });

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.recommendation).toBe('internal error');

      // Should publish error event with string error
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'error',
        payload: {
          agent: 'AUDIT',
          message: 'Unknown audit error',
          details: 'String error'
        }
      });

      // Restore original
      JSON.parse = originalParse;
    });
  });

  describe('Gemini integration', () => {
    it('should use Gemini audit with constitution when GeminiChat is available', async () => {
      // Create agent with GeminiChat
      const auditAgentWithGemini = new AuditAgent(mockBus, mockGeminiChat);
      
      // Mock successful Gemini response
      (mockGeminiChat.sendMessage as Mock).mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: '{"pass": true, "reasons": []}'
            }]
          }
        }]
      });

      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: ['test.txt']
      });

      const result = await auditAgentWithGemini.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(true);
      expect(result.output?.reasons).toEqual([]);

      // Verify mindLoader was called
      expect(mockLoadPrompt).toHaveBeenCalledWith('audit.constitution');

      // Verify GeminiChat was called
      expect(mockGeminiChat.sendMessage).toHaveBeenCalledWith(
        {
          message: expect.stringContaining('You are an audit agent')
        },
        'audit-validation'
      );

      // Should publish success log with Gemini indicator
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'log',
        payload: 'AUDIT PASSED: All quality checks successful (Gemini)'
      });
    });

    it('should handle Gemini audit failure response', async () => {
      const auditAgentWithGemini = new AuditAgent(mockBus, mockGeminiChat);
      
      // Mock Gemini response with failure
      (mockGeminiChat.sendMessage as Mock).mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: '{"pass": false, "reasons": ["Missing error handling", "Code quality issues"]}'
            }]
          }
        }]
      });

      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: ['test.txt']
      });

      const result = await auditAgentWithGemini.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(false);
      expect(result.output?.reasons).toEqual(['Missing error handling', 'Code quality issues']);
      expect(result.output?.recommendation).toBe('Audit failed: Missing error handling; Code quality issues');

      // Should publish failure log with Gemini indicator
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'log',
        payload: 'AUDIT FAILED: 2 issue(s) found (Gemini)'
      });
    });

    it('should fall back to rule-based validation when constitution prompt is missing', async () => {
      const auditAgentWithGemini = new AuditAgent(mockBus, mockGeminiChat);
      
      // Mock prompt loading to return null (missing prompt)
      mockLoadPrompt.mockResolvedValue(null);

      // Mock fs.access to succeed
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: []
      });

      const result = await auditAgentWithGemini.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(true);

      // Verify error event was emitted
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'error',
        payload: {
          agent: 'AUDIT',
          message: 'Gemini audit failed: Constitution prompt not found',
          details: expect.any(String)
        }
      });

      // Verify fallback log was emitted
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'log',
        payload: 'Falling back to rule-based audit validation'
      });

      // Should use rule-based validation success message
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'log',
        payload: 'AUDIT PASSED: All quality checks successful (rule-based)'
      });

      // GeminiChat should not be called when prompt is missing
      expect(mockGeminiChat.sendMessage).not.toHaveBeenCalled();
    });

    it('should fall back to rule-based validation when Gemini returns invalid JSON', async () => {
      const auditAgentWithGemini = new AuditAgent(mockBus, mockGeminiChat);
      
      // Mock Gemini response with invalid JSON
      (mockGeminiChat.sendMessage as Mock).mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              text: 'invalid json response'
            }]
          }
        }]
      });

      // Mock fs.access to succeed
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: []
      });

      const result = await auditAgentWithGemini.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(true);

      // Verify error event was emitted for JSON parse failure
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'error',
        payload: {
          agent: 'AUDIT',
          message: expect.stringContaining('Invalid JSON response from Gemini'),
          details: expect.any(String)
        }
      });

      // Verify fallback to rule-based validation
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'log',
        payload: 'Falling back to rule-based audit validation'
      });
    });

    it('should use rule-based validation when no GeminiChat is provided', async () => {
      // Use agent without GeminiChat (original setup)
      const validPlan = createValidPlan();
      const context = createContext({
        planJson: JSON.stringify(validPlan),
        artifacts: []
      });

      // Mock fs.access to succeed
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const result = await auditAgent.run(context);

      expect(result.ok).toBe(true);
      expect(result.output?.pass).toBe(true);

      // mindLoader should not be called when no GeminiChat
      expect(mockLoadPrompt).not.toHaveBeenCalled();

      // Should use rule-based validation success message
      expect(publishSpy).toHaveBeenCalledWith({
        ts: expect.any(Number),
        type: 'log',
        payload: 'AUDIT PASSED: All quality checks successful (rule-based)'
      });
    });
  });
});
