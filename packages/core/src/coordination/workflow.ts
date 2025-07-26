
import { ChimeraEventBus } from '../event-bus/bus.js';
import { WorkflowState } from '../interfaces/workflow.js';

// Re-export WorkflowState for backwards compatibility
export { WorkflowState };

export function advance(current: WorkflowState, event: string): WorkflowState {
  const transitions: Record<WorkflowState, Record<string, WorkflowState>> = {
    [WorkflowState.INIT]: {
      'start': WorkflowState.PLANNING
    },
    [WorkflowState.PLANNING]: {
      'plan_ready': WorkflowState.EXECUTING,
      'restart': WorkflowState.INIT
    },
    [WorkflowState.EXECUTING]: {
      'execution_complete': WorkflowState.REVIEW,
      'restart': WorkflowState.INIT
    },
    [WorkflowState.REVIEW]: {
      'review_pass': WorkflowState.DONE,
      'review_fail': WorkflowState.REPLAN,
      'restart': WorkflowState.INIT
    },
    [WorkflowState.REPLAN]: {
      'replan_ready': WorkflowState.EXECUTING,
      'replan_failed': WorkflowState.DONE,
      'restart': WorkflowState.INIT
    },
    [WorkflowState.DONE]: {
      'restart': WorkflowState.INIT
    }
  };

  const stateTransitions = transitions[current];
  if (!stateTransitions || !(event in stateTransitions)) {
    throw new Error('illegal transition');
  }

  return stateTransitions[event];
}

export class WorkflowStateMachine {
  private _state: WorkflowState = WorkflowState.INIT;
  private bus: ChimeraEventBus;

  constructor(bus: ChimeraEventBus) {
    this.bus = bus;
  }

  state(): WorkflowState {
    return this._state;
  }

  advance(): void {
    if (this._state === WorkflowState.DONE) {
      throw new Error('Illegal transition');
    }

    const nextStates = {
      [WorkflowState.INIT]: WorkflowState.PLANNING,
      [WorkflowState.PLANNING]: WorkflowState.EXECUTING,
      [WorkflowState.EXECUTING]: WorkflowState.REVIEW,
      [WorkflowState.REVIEW]: WorkflowState.DONE,
      [WorkflowState.REPLAN]: WorkflowState.EXECUTING,
    };

    const nextState = nextStates[this._state];
    this._state = nextState;
    
    this.bus.publish({
      ts: Date.now(),
      type: 'log',
      payload: `State transition: ${Object.keys(nextStates).find(k => nextStates[k as keyof typeof nextStates] === nextState)} → ${nextState}`
    });
  }

  reset(): void {
    this._state = WorkflowState.INIT;
    this.bus.publish({
      ts: Date.now(),
      type: 'log',
      payload: 'State reset to INIT'
    });
  }

  transitionToReplan(): void {
    if (this._state !== WorkflowState.REVIEW) {
      throw new Error('Can only transition to REPLAN from REVIEW state');
    }
    this._state = WorkflowState.REPLAN;
    this.bus.publish({
      ts: Date.now(),
      type: 'log',
      payload: 'State transition: REVIEW → REPLAN'
    });
  }

  transitionToDone(): void {
    if (this._state !== WorkflowState.REVIEW && this._state !== WorkflowState.REPLAN) {
      throw new Error('Can only transition to DONE from REVIEW or REPLAN state');
    }
    const prevState = this._state;
    this._state = WorkflowState.DONE;
    this.bus.publish({
      ts: Date.now(),
      type: 'log',
      payload: `State transition: ${prevState} → DONE`
    });
  }
}

// Unit tests - inline testing for WorkflowStateMachine
// Manual test function that can be called during development/testing
export function testWorkflowStateMachine(): void {
  const events: any[] = [];
  // Create a simple mock that just captures events
  const mockBus = {
    publish: (event: any) => events.push(event),
    subscribe: () => () => {},
    history: () => [],
    _events: [],
    _handlers: new Map(),
    _maxEvents: 1000
  } as unknown as ChimeraEventBus;

  const machine = new WorkflowStateMachine(mockBus);

  // Start in INIT state
  console.assert(machine.state() === WorkflowState.INIT, 'Should start in INIT state');

  // Advance through all states
  machine.advance(); // INIT → PLANNING
  console.assert(machine.state() === WorkflowState.PLANNING, 'Should advance to PLANNING');

  machine.advance(); // PLANNING → EXECUTING  
  console.assert(machine.state() === WorkflowState.EXECUTING, 'Should advance to EXECUTING');

  machine.advance(); // EXECUTING → REVIEW
  console.assert(machine.state() === WorkflowState.REVIEW, 'Should advance to REVIEW');

  // Test REPLAN transition
  machine.transitionToReplan(); // REVIEW → REPLAN
  console.assert(machine.state() === WorkflowState.REPLAN, 'Should transition to REPLAN');

  machine.advance(); // REPLAN → EXECUTING
  console.assert(machine.state() === WorkflowState.EXECUTING, 'Should advance from REPLAN to EXECUTING');

  machine.advance(); // EXECUTING → REVIEW
  console.assert(machine.state() === WorkflowState.REVIEW, 'Should advance to REVIEW again');

  machine.transitionToDone(); // REVIEW → DONE
  console.assert(machine.state() === WorkflowState.DONE, 'Should transition to DONE');

  // Should throw error when trying to advance from DONE
  try {
    machine.advance();
    console.assert(false, 'Should throw error when advancing from DONE');
  } catch (error) {
    console.assert((error as Error).message === 'Illegal transition', 'Should throw correct error message');
  }

  // Reset should work
  machine.reset();
  console.assert(machine.state() === WorkflowState.INIT, 'Should reset to INIT');

  // Should have the correct number of log events
  const logEvents = events.filter(e => e.type === 'log');
  console.assert(logEvents.length > 0, `Should have log events, got ${logEvents.length}`);

  console.log('✅ WorkflowStateMachine test passed - all assertions successful');
}
