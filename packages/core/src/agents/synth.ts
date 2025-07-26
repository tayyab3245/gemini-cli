/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentContext, AgentResult } from './agent.js';
import { ChimeraEventBus } from '../event-bus/bus.js';
import { AgentType } from '../event-bus/types.js';
import type { PlanStep, ChimeraPlan } from '../interfaces/chimera.js';
import type { GeminiChat } from '../core/geminiChat.js';
import { loadPrompt } from '../utils/mindLoader.js';

// Constant for prompt file path - centralised to avoid string literal duplication
const PROMPT_FILE = 'synth.prompt';

// Fallback prompt when mind loading fails
const DEFAULT_SYNTH_PROMPT = `You are an AI assistant that generates implementation plans for development tasks.

**Instructions:**
1. Break down the user's request into actionable steps
2. Each step must be specific and concrete
3. Generate at least 3 steps minimum
4. Each step should depend on previous steps where logical
5. Focus on implementation details, not planning

**Output Format:**
Provide a JSON array of plan steps, where each step has:
- step_id: unique identifier (e.g., "S1", "S2", etc.)
- description: what to do in this step
- depends_on: array of step_ids this depends on
- status: always "pending"
- artifacts: empty array initially
- attempts: 0
- max_attempts: 3

**Example Output:**
[
  {"step_id": "S1", "description": "create initial implementation", "depends_on": [], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3},
  {"step_id": "S2", "description": "add error handling", "depends_on": ["S1"], "status": "pending", "artifacts": [], "attempts": 0, "max_attempts": 3}
]`;
import { withTimeout, withRetries } from '../coordination/recovery.js';

export interface SynthInput {
  clarifiedUserInput: string;
  assumptions: string[];
  constraints: string[];
}

export interface SynthOutput {
  planJson: string;
}

export { PlanStep, PROMPT_FILE };

export class SynthAgent {
  readonly id = AgentType.SYNTH;
  private bus: ChimeraEventBus;
  private geminiChat?: GeminiChat;

  constructor(bus: ChimeraEventBus, geminiChat?: GeminiChat) {
    this.bus = bus;
    this.geminiChat = geminiChat;
  }

  async run(
    ctx: AgentContext<SynthInput>
  ): Promise<AgentResult<SynthOutput>> {
    this.bus.publish({ ts: Date.now(), type: 'agent-start', payload: { id: this.id }});

    try {
      // Progress: 25% - Starting plan generation
      this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 25 }});

      let steps: PlanStep[];

      if (this.geminiChat) {
        // Try to load prompt from mind folder
        let prompt: string | null = null;
        try {
          prompt = await loadPrompt(PROMPT_FILE);
        } catch (error) {
          // Contract violation errors should bubble up as they indicate a serious issue
          if (error instanceof Error && error.message.includes('loadPrompt()')) {
            this.bus.publish({ 
              ts: Date.now(), 
              type: 'error', 
              payload: { 
                agent: 'SYNTH', 
                message: error.message,
                stack: error.stack
              } 
            });
          }
          // Log the error and continue with fallback prompt
          this.bus.publish({ 
            ts: Date.now(), 
            type: 'log', 
            payload: `Mind prompt loading failed: ${error instanceof Error ? error.message : String(error)}, using fallback prompt` 
          });
        }

        // Use live prompt or fallback prompt
        const finalPrompt = prompt || DEFAULT_SYNTH_PROMPT;
        
        // Progress: 40% - Prompt ready, calling Gemini
        this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 40 }});

        try {
          const response = await withRetries(
            () =>
              withTimeout(
                this.geminiChat!.sendMessage(
                  {
                    message: `${finalPrompt}

User Input: "${ctx.input.clarifiedUserInput}"
Assumptions: ${ctx.input.assumptions.join(', ')}
Constraints: ${ctx.input.constraints.join(', ')}

Plan Steps:`
                  },
                  'synth-planning'
                ),
                60_000
              ),
            3
          );

          // Progress: 60% - Gemini response received
          this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 60 }});

          // Parse Gemini response
          steps = this.parseGeminiResponse(response);

          if (steps.length < 3) {
            this.bus.publish({ ts: Date.now(), type: 'log', payload: 'Gemini plan too short, falling back to local generation' });
            steps = this.generatePlanSteps(ctx.input);
          }
        } catch (geminiError) {
          // Emit single error event (withRetries already threw, so we emit once here)
          this.bus.publish({ 
            ts: Date.now(), 
            type: 'error', 
            payload: { 
              agent: 'SYNTH', 
              message: geminiError instanceof Error ? geminiError.message : String(geminiError),
              stack: geminiError instanceof Error ? geminiError.stack : undefined
            } 
          });
          this.bus.publish({ ts: Date.now(), type: 'log', payload: `Gemini error: ${geminiError instanceof Error ? geminiError.message : String(geminiError)}, falling back` });
          steps = this.generatePlanSteps(ctx.input);
        }
      } else {
        // Fallback: generate plan locally when GeminiChat is unavailable
        steps = this.generatePlanSteps(ctx.input);
      }

      // Progress: 75% - Plan steps generated
      this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 75 }});

      const planJson = this.formatPlanAsJson(steps, ctx.input);

      // Progress: 100% - Complete
      this.bus.publish({ ts: Date.now(), type: 'progress', payload: { percent: 100 }});

      this.bus.publish({ ts: Date.now(), type: 'agent-end', payload: { id: this.id }});
      return { ok: true, output: { planJson } };

    } catch (error) {
      this.bus.publish({
        ts: Date.now(),
        type: 'error',
        payload: {
          agent: 'SYNTH',
          message: error instanceof Error ? error.message : 'Unknown planning error',
          details: error instanceof Error ? error.stack : String(error)
        }
      });
      this.bus.publish({ ts: Date.now(), type: 'agent-end', payload: { id: this.id }});
      return { ok: false, error: `Planning failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private parseGeminiResponse(response: any): PlanStep[] {
    try {
      // Extract response text from Gemini response
      let responseText = '';
      if (response?.candidates?.[0]?.content?.parts) {
        responseText = response.candidates[0].content.parts
          .map((part: any) => part.text)
          .join('')
          .trim();
      }

      if (!responseText) {
        throw new Error('Empty response from Gemini');
      }

      // Try to extract JSON array from the response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }

      const planSteps = JSON.parse(jsonMatch[0]);
      
      if (!Array.isArray(planSteps)) {
        throw new Error('Response is not a valid array');
      }

      // Validate and normalize the steps
      return planSteps.map((step: any, index: number) => ({
        step_id: step.step_id || `S${index + 1}`,
        description: step.description || `Step ${index + 1}`,
        depends_on: Array.isArray(step.depends_on) ? step.depends_on : (index === 0 ? [] : [`S${index}`]),
        status: 'pending' as const,
        artifacts: Array.isArray(step.artifacts) ? step.artifacts : [],
        attempts: 0,
        max_attempts: step.max_attempts || 3
      }));
    } catch (error) {
      throw new Error(`Failed to parse Gemini response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private generatePlanSteps(input: SynthInput): PlanStep[] {
    const steps: PlanStep[] = [];
    const planVerbs = ['write', 'create', 'generate', 'run', 'test'];
    
    // Analyze input to determine plan complexity (minimum 3 steps, max 5)
    const complexity = Math.max(this.determinePlanComplexity(input), 3);
    
    for (let i = 0; i < complexity; i++) {
      const stepId = `S${i + 1}`;
      const verb = planVerbs[i % planVerbs.length];
      const description = this.generateStepDescription(verb, input, i + 1, complexity);
      const dependsOn = i === 0 ? [] : [`S${i}`];

      steps.push({
        step_id: stepId,
        description,
        depends_on: dependsOn,
        status: 'pending',
        artifacts: [],
        attempts: 0,
        max_attempts: 3
      });
    }

    return steps;
  }

  private determinePlanComplexity(input: SynthInput): number {
    const { clarifiedUserInput, constraints } = input;
    let complexity = 3; // Start with minimum 3 steps

    // Increase complexity based on input analysis (case-insensitive)
    const inputLower = clarifiedUserInput.toLowerCase();
    if (inputLower.includes('test') || inputLower.includes('validate')) complexity++;
    if (inputLower.includes('multiple') || inputLower.includes('several')) complexity++;
    if (constraints.some(c => c.toLowerCase().includes('step') || c.toLowerCase().includes('phase'))) complexity++;
    if (clarifiedUserInput.length > 100) complexity++;

    return Math.min(Math.max(complexity, 3), 5); // Ensure 3-5 steps
  }

  private generateStepDescription(verb: string, input: SynthInput, stepNum: number, totalSteps: number): string {
    const { clarifiedUserInput } = input;
    
    if (totalSteps === 1) {
      return `${verb} ${clarifiedUserInput.toLowerCase()}`;
    }

    // Multi-step plans
    switch (stepNum) {
      case 1:
        return `${verb} initial implementation for ${this.extractMainObject(clarifiedUserInput)}`;
      case 2:
        return stepNum === totalSteps ? 
          `test and validate the implementation` : 
          `${verb} supporting components and configuration`;
      case 3:
        return stepNum === totalSteps ? 
          `test and validate the complete solution` : 
          `${verb} integration and connection logic`;
      case 4:
        return stepNum === totalSteps ? 
          `test and validate all components` : 
          `${verb} error handling and edge cases`;
      case 5:
        return `test and validate the complete implementation`;
      default:
        return `${verb} additional implementation details`;
    }
  }

  private extractMainObject(input: string): string {
    // Extract the main object/concept from the clarified input
    const words = input.toLowerCase().split(' ');
    const objectWords = words.filter(word => 
      !['a', 'an', 'the', 'that', 'this', 'create', 'build', 'make', 'generate', 'write'].includes(word)
    );
    return objectWords.slice(0, 3).join(' ') || 'the requested solution';
  }

  private formatPlanAsJson(steps: PlanStep[], input: SynthInput): string {
    const now = new Date().toISOString();
    const plan: ChimeraPlan = {
      task_id: `task-${Date.now()}`,
      original_user_request: input.clarifiedUserInput,
      requirements: [input.clarifiedUserInput], // Basic requirement from user input
      assumptions: input.assumptions,
      constraints: input.constraints,
      plan: steps,
      status: 'pending',
      created_at: now,
      updated_at: now,
      model_versions: { synth: 'gemini-1.5-flash' }, // Default model version
      history: []
    };

    return JSON.stringify(plan, null, 2);
  }
}