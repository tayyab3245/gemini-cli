import type { AgentKind } from '../interfaces/agent.js';
import type { PlanStep } from '../interfaces/chimera.js';

// BaseContext interface - contains all possible context fields
export interface BaseContext {
  userInput?: string;
  clarifiedUserInput?: string;         // Kernel's refined task sentence
  assumptions?: string[];              // Kernel's detected assumptions
  constraints?: string[];              // Kernel's detected constraints
  planJson?: string;
  planStep?: PlanStep;
  artifacts?: string[];
  previous_feedback?: string;          // Audit feedback for re-planning
}

export function buildContextSlice<T extends BaseContext>(
  agent: AgentKind,
  full: T,
): Partial<T> {
  switch (agent) {
    case 'KERNEL':
      return full;                                      // gets everything
    case 'SYNTH':
      return { 
        clarifiedUserInput: full.clarifiedUserInput || full.userInput,
        assumptions: full.assumptions || [],
        constraints: full.constraints || [],
        planJson: full.planJson,
        previous_feedback: full.previous_feedback
      } as Partial<T>;
    case 'DRIVE':
      return { planStep: full.planStep, artifacts: full.artifacts } as Partial<T>;
    case 'AUDIT':
      return { planJson: full.planJson, artifacts: full.artifacts } as Partial<T>;
    default:
      return {};
  }
}

// Unit tests
// @ts-ignore - vitest adds this at runtime  
if (typeof import.meta.vitest !== 'undefined') {
  // @ts-ignore - vitest adds this at runtime
  const { test, expect } = import.meta.vitest;

  test('buildContextSlice filters context correctly', () => {
    const testPlanStep: PlanStep = {
      step_id: 'S1',
      description: 'test step',
      depends_on: [],
      status: 'pending',
      artifacts: [],
      attempts: 0,
      max_attempts: 3
    };

    const ctx: BaseContext = { 
      userInput: 'test', 
      clarifiedUserInput: 'Create test app',
      assumptions: ['assumption1', 'assumption2'],
      constraints: ['constraint1'],
      planJson: '{}', 
      planStep: testPlanStep, 
      artifacts: ['f1'] 
    };
    
    expect(buildContextSlice('KERNEL', ctx)).toEqual(ctx);
    expect(buildContextSlice('SYNTH', ctx)).toEqual({ 
      clarifiedUserInput: 'Create test app', 
      assumptions: ['assumption1', 'assumption2'],
      constraints: ['constraint1'],
      planJson: '{}' 
    });
    expect(buildContextSlice('DRIVE', ctx)).toEqual({ planStep: testPlanStep, artifacts: ['f1'] });
    expect(buildContextSlice('AUDIT', ctx)).toEqual({ planJson: '{}', artifacts: ['f1'] });
  });
}
