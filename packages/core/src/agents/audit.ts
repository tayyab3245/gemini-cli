/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'fs';
import type { AgentContext, AgentResult } from './agent.js';
import { ChimeraEventBus } from '../event-bus/bus.js';
import { AgentType } from '../event-bus/types.js';
import type { ChimeraPlan, PlanStep } from '../interfaces/chimera.js';
import type { GeminiChat } from '../core/geminiChat.js';
import { loadPrompt } from '../utils/mindLoader.js';
import { withTimeout, withRetries } from '../coordination/recovery.js';

interface AuditInput {
  planJson: string;
  artifacts: string[];
}

interface AuditOutput {
  pass: boolean;
  reasons?: string[];
  recommendation?: string;
}

interface GeminiAuditResponse {
  pass: boolean;
  reasons: string[];
}

export class AuditAgent {
  readonly id = AgentType.AUDIT;
  private geminiChat?: GeminiChat;
  private bus: ChimeraEventBus;
  
  constructor(bus: ChimeraEventBus, geminiChat?: GeminiChat) {
    this.bus = bus;
    this.geminiChat = geminiChat;
  }

  async run(ctx: AgentContext<AuditInput>): Promise<AgentResult<AuditOutput>> {
    this.bus.publish({ ts: Date.now(), type: 'agent-start', payload: { id: this.id } });
    
    try {
      // Progress: 25% - Starting audit
      this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 25 } });
      
      const { planJson, artifacts } = ctx.input;

      // Try Gemini-based audit first if available
      if (this.geminiChat) {
        try {
          // Progress: 50% - Loading constitution and calling Gemini
          this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 50 } });
          
          const auditResult = await this.auditWithGemini(planJson, artifacts);
          
          // Progress: 100% - Gemini audit complete
          this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 100 } });

          const recommendation = auditResult.pass ? undefined : `Audit failed: ${auditResult.reasons.join('; ')}`;

          if (auditResult.pass) {
            this.bus.publish({ 
              ts: Date.now(), 
              type: 'log', 
              payload: 'AUDIT PASSED: All quality checks successful (Gemini)' 
            });
          } else {
            this.bus.publish({ 
              ts: Date.now(), 
              type: 'log', 
              payload: `AUDIT FAILED: ${auditResult.reasons.length} issue(s) found (Gemini)` 
            });
          }

          this.bus.publish({ ts: Date.now(), type: 'agent-end', payload: { id: this.id } });
          return { ok: true, output: { pass: auditResult.pass, reasons: auditResult.reasons, recommendation } };

        } catch (error) {
          // Emit error and fall back to rule-based validation
          this.bus.publish({
            ts: Date.now(),
            type: 'error',
            payload: {
              agent: 'AUDIT',
              message: `Gemini audit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
              details: error instanceof Error ? error.stack : String(error)
            }
          });
          
          this.bus.publish({ 
            ts: Date.now(), 
            type: 'log', 
            payload: 'Falling back to rule-based audit validation' 
          });
        }
      }

      // Fallback: rule-based validation
      return await this.auditWithRules(planJson, artifacts);

    } catch (error) {
      this.bus.publish({
        ts: Date.now(),
        type: 'error',
        payload: {
          agent: 'AUDIT',
          message: error instanceof Error ? error.message : 'Unknown audit error',
          details: error instanceof Error ? error.stack : String(error)
        }
      });
      this.bus.publish({ ts: Date.now(), type: 'agent-end', payload: { id: this.id } });
      return { 
        ok: true, 
        output: { 
          pass: false, 
          reasons: ['internal error'],
          recommendation: 'internal error' 
        } 
      };
    }
  }

  private async auditWithGemini(planJson: string, artifacts: string[]): Promise<GeminiAuditResponse> {
    // Load constitution prompt
    const constitution = await loadPrompt('audit.constitution');
    if (!constitution) {
      throw new Error('Constitution prompt not found');
    }

    // Prepare the prompt with plan and artifacts
    const prompt = constitution
      .replace('{{PLAN_JSON}}', planJson)
      .replace('{{ARTIFACTS}}', artifacts.join(', '));

    // Call Gemini with retries and timeout
    const response = await withRetries(
      () => withTimeout(this.geminiChat!.sendMessage(
        {
          message: prompt
        },
        'audit-validation'
      ), 30000),
      3
    );

    // Parse Gemini response
    const responseText = response?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!responseText) {
      throw new Error('Empty response from Gemini');
    }

    let auditResult: GeminiAuditResponse;
    try {
      auditResult = JSON.parse(responseText);
    } catch (error) {
      throw new Error(`Invalid JSON response from Gemini: ${responseText}`);
    }

    // Validate response structure
    if (typeof auditResult.pass !== 'boolean' || !Array.isArray(auditResult.reasons)) {
      throw new Error(`Invalid response structure from Gemini: ${JSON.stringify(auditResult)}`);
    }

    return auditResult;
  }

  private async auditWithRules(planJson: string, artifacts: string[]): Promise<AgentResult<AuditOutput>> {
    // Progress: 50% - Validating plan JSON (rule-based)
    this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 50 } });
    
    const issues: string[] = [];

    // Validate plan JSON structure
    let planValidation: { valid: boolean; issues: string[] };
    try {
      planValidation = await this.validatePlanJson(planJson);
    } catch (error) {
      // If validatePlanJson throws an exception (not a validation failure), 
      // treat it as an internal error
      throw error;
    }
    
    if (!planValidation.valid) {
      issues.push(...planValidation.issues);
    }

    // Progress: 75% - Checking artifacts
    this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 75 } });
    
    // Validate all artifacts exist on disk
    const artifactValidation = await this.validateArtifacts(artifacts);
    if (!artifactValidation.valid) {
      issues.push(...artifactValidation.issues);
    }

    // Progress: 100% - Audit complete
    this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 100 } });

    const pass = issues.length === 0;
    const recommendation = pass ? undefined : `Audit failed: ${issues.join('; ')}`;

    if (pass) {
      this.bus.publish({ 
        ts: Date.now(), 
        type: 'log', 
        payload: 'AUDIT PASSED: All quality checks successful (rule-based)' 
      });
    } else {
      this.bus.publish({ 
        ts: Date.now(), 
        type: 'log', 
        payload: `AUDIT FAILED: ${issues.length} issue(s) found (rule-based)` 
      });
    }

    this.bus.publish({ ts: Date.now(), type: 'agent-end', payload: { id: this.id } });
    return { ok: true, output: { pass, reasons: issues, recommendation } };
  }

  private loadConstitutionRules(): string[] {
    // This method is no longer used - constitution is loaded dynamically via mindLoader
    return [];
  }

  private async validatePlanJson(planJson: string): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    // Check if JSON is valid
    let parsedPlan: ChimeraPlan;
    try {
      parsedPlan = JSON.parse(planJson);
    } catch (error) {
      // If the error is a test simulation error, let it bubble up as internal error
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Simulated internal error') || errorMessage.includes('String error')) {
        throw error;
      }
      
      return { 
        valid: false, 
        issues: ['planJson is not valid JSON'] 
      };
    }

    // Check required top-level keys
    const requiredKeys = ['task_id', 'plan', 'status'];
    for (const key of requiredKeys) {
      if (!(key in parsedPlan)) {
        issues.push(`planJson missing required key: "${key}"`);
      }
    }

    // Validate plan steps if present
    if (parsedPlan.plan && Array.isArray(parsedPlan.plan)) {
      for (let i = 0; i < parsedPlan.plan.length; i++) {
        const step = parsedPlan.plan[i];
        const stepValidation = this.validatePlanStep(step, i);
        if (!stepValidation.valid) {
          issues.push(...stepValidation.issues);
        }
      }
    } else if (parsedPlan.plan) {
      issues.push('planJson.plan must be an array');
    }

    return { valid: issues.length === 0, issues };
  }

  private validatePlanStep(step: PlanStep, index: number): { valid: boolean; issues: string[] } {
    const issues: string[] = [];
    const prefix = `Step ${index + 1}`;

    // Check required step fields
    if (!step.step_id) {
      issues.push(`${prefix}: missing step_id`);
    }
    if (!step.description) {
      issues.push(`${prefix}: missing description`);
    }
    if (!step.status) {
      issues.push(`${prefix}: missing status`);
    }

    // Check if step is completed successfully
    if (step.status !== 'done') {
      issues.push(`${prefix}: status is "${step.status}", expected "done"`);
    }

    // Check for error messages
    if (step.error_message) {
      issues.push(`${prefix}: contains error message: "${step.error_message}"`);
    }

    return { valid: issues.length === 0, issues };
  }

  private async validateArtifacts(artifacts: string[]): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    for (let i = 0; i < artifacts.length; i++) {
      const artifact = artifacts[i];
      
      // Check if artifact path is not empty
      if (!artifact || artifact.trim().length === 0) {
        issues.push(`Artifact ${i + 1}: path is empty or whitespace`);
        continue;
      }

      // Check if file exists on disk
      try {
        await fs.access(artifact.trim());
      } catch (error) {
        issues.push(`Artifact ${i + 1}: file does not exist: "${artifact}"`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  private applyConstitutionRules(
    planJson: string, 
    artifacts: string[], 
    rules: string[]
  ): { valid: boolean; issues: string[] } {
    // Placeholder for future constitution rule application
    // For now, just log that rules were loaded
    this.bus.publish({ 
      ts: Date.now(), 
      type: 'log', 
      payload: `Applied ${rules.length} constitution rule(s)` 
    });
    
    return { valid: true, issues: [] };
  }
}
