import { ChimeraEventBus } from '../event-bus/bus.js';
import { AgentKind } from '../interfaces/agent.js';
import { WorkflowState } from '../interfaces/workflow.js';
import { buildContextSlice, BaseContext } from '../context/broker.js';
import { WorkflowStateMachine } from './workflow.js';
import { withTimeout, withRetries } from './recovery.js';
import { KernelAgent } from '../agents/kernel.js';
import { SynthAgent } from '../agents/synth.js';
import { DriveAgent } from '../agents/drive.js';
import { AuditAgent } from '../agents/audit.js';
import type { AgentContext } from '../agents/agent.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { GeminiChat } from '../core/geminiChat.js';

export class WorkflowEngine {
  private stateMachine: WorkflowStateMachine;
  private kernel: KernelAgent;
  private synth: SynthAgent;
  private drive: DriveAgent;
  private audit: AuditAgent;

  constructor(private bus: ChimeraEventBus, private geminiChat: GeminiChat, private toolRegistry?: ToolRegistry) {
    this.stateMachine = new WorkflowStateMachine(bus);
    this.kernel = new KernelAgent(bus, geminiChat);
    this.synth = new SynthAgent(bus, geminiChat);
    this.drive = new DriveAgent(bus, geminiChat);
    this.audit = new AuditAgent(bus);
    
    // Subscribe to chat messages from WebSocket clients
    this.bus.subscribe('chat-message', (event) => {
      this.handleChatMessage(event.payload.text);
    });
  }

  async run(userInput: string): Promise<void> {
    // ① publish workflow‑start
    this.bus.publish({
      ts: Date.now(),
      type: 'log',
      payload: 'workflow-start'
    });

    // ② build initial context
    const fullContext: BaseContext = {
      userInput,
      planJson: '{}',
      planStep: {
        step_id: 'initial',
        description: 'Initial workflow step',
        depends_on: [],
        status: 'pending',
        artifacts: [],
        attempts: 0,
        max_attempts: 3
      },
      artifacts: []
    };

    try {
      // ③ call Kernel → Synth → Drive → Audit in sequence with retries and timeouts
      await this.runAgent('KERNEL', fullContext);
      await this.runAgent('SYNTH', fullContext);
      await this.runAgent('DRIVE', fullContext);
      await this.runAgent('AUDIT', fullContext);

      // ④ publish workflow-complete
      this.bus.publish({
        ts: Date.now(),
        type: 'log',
        payload: 'workflow-complete'
      });
    } catch (error) {
      // Publish error event and re-throw to abort workflow
      this.bus.publish({
        ts: Date.now(),
        type: 'error',
        payload: {
          agent: 'WORKFLOW',
          message: error instanceof Error ? error.message : 'Unknown workflow error',
          stack: error instanceof Error ? error.stack : String(error)
        }
      });
      throw error;
    }
  }

  private async runAgent(agentKind: AgentKind, fullContext: BaseContext): Promise<void> {
    // Emit agent-start event
    this.bus.publish({
      ts: Date.now(),
      type: 'log',
      payload: `agent-start-${agentKind}`
    });

    // Advance state machine
    this.stateMachine.advance();

    try {
      // Execute agent with retry and timeout logic
      const result = await withRetries(
        () => withTimeout(this.executeAgent(agentKind, fullContext), 60_000),
        3
      );

      // Update fullContext with agent outputs
      if (agentKind === 'KERNEL' && result.output) {
        // Handle both string outputs (legacy) and object outputs (new format)
        if (typeof result.output === 'string') {
          fullContext.clarifiedUserInput = result.output;
        } else {
          // New format with assumptions and constraints
          fullContext.clarifiedUserInput = result.output.clarifiedUserInput;
          fullContext.assumptions = result.output.assumptions;
          fullContext.constraints = result.output.constraints;
        }
        
        // Log context slice preparation for SYNTH
        this.bus.publish({
          ts: Date.now(),
          type: 'log',
          payload: 'Context slice prepared for SYNTH'
        });
      }

      if (agentKind === 'SYNTH' && result.output) {
        // Store the planJson for AUDIT
        fullContext.planJson = result.output.planJson;
        
        // Parse planJson and extract first plan step for DRIVE
        try {
          const plan = JSON.parse(result.output.planJson);
          this.bus.publish({
            ts: Date.now(),
            type: 'log',
            payload: `Parsed plan structure: ${JSON.stringify({
              hasPlan: !!plan.plan,
              planIsArray: Array.isArray(plan.plan),
              planLength: plan.plan?.length || 0,
              firstStep: plan.plan?.[0] || null
            })}`
          });
          
          if (plan.plan && Array.isArray(plan.plan) && plan.plan.length > 0) {
            fullContext.planStep = plan.plan[0]; // Take first plan step for now
            this.bus.publish({
              ts: Date.now(),
              type: 'log',
              payload: `Plan step description: ${fullContext.planStep?.description || 'undefined'}`
            });
          } else {
            throw new Error('Plan JSON does not contain valid plan steps');
          }
        } catch (parseError) {
          this.bus.publish({
            ts: Date.now(),
            type: 'log',
            payload: `Failed to parse planJson: ${result.output.planJson}`
          });
          throw new Error(`Failed to parse plan JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        }
        
        // Log context slice preparation for DRIVE
        this.bus.publish({
          ts: Date.now(),
          type: 'log',
          payload: 'Context slice prepared for DRIVE with first plan step'
        });
      }

      if (agentKind === 'DRIVE' && result.output) {
        // Update artifacts from DRIVE execution
        fullContext.artifacts = result.output.artifacts;
      }
    } catch (error) {
      // Publish error event on final failure
      this.bus.publish({
        ts: Date.now(),
        type: 'error',
        payload: {
          agent: agentKind,
          message: error instanceof Error ? error.message : 'Unknown agent error',
          stack: error instanceof Error ? error.stack : String(error)
        }
      });
      throw error; // Re-throw to abort workflow
    }

    // Emit agent-end event
    this.bus.publish({
      ts: Date.now(),
      type: 'log',
      payload: `agent-end-${agentKind}`
    });
  }

  private async executeAgent(agentKind: AgentKind, fullContext: BaseContext): Promise<any> {
    // Build context slice for the specific agent
    const contextSlice = buildContextSlice(agentKind, fullContext);
    const agentContext: AgentContext<any> = {
      input: contextSlice,
      bus: this.bus,
      dependencies: {
        toolRegistry: this.toolRegistry
      }
    };

    // Execute the appropriate agent
    let result;
    switch (agentKind) {
      case 'KERNEL':
        result = await this.kernel.run(agentContext);
        break;
      case 'SYNTH':
        result = await this.synth.run(agentContext);
        break;
      case 'DRIVE':
        result = await this.drive.run(agentContext);
        break;
      case 'AUDIT':
        result = await this.audit.run(agentContext);
        break;
      default:
        throw new Error(`Unknown agent kind: ${agentKind}`);
    }

    // Check if the agent execution was successful
    if (!result.ok) {
      throw new Error(result.error || `Agent ${agentKind} execution failed`);
    }

    return result;
  }

  /**
   * Handle incoming chat messages from WebSocket clients
   */
  private async handleChatMessage(text: string): Promise<void> {
    try {
      console.log('Processing chat message:', text);
      
      // Create agent context for the chat message
      const ctx: AgentContext<{ userInput: string }> = {
        input: { userInput: text },
        bus: this.bus,
      };

      // Process the message with KernelAgent (already has ACK handshake logic)
      const result = await this.kernel.run(ctx);
      
      if (result.ok && result.output) {
        // Broadcast the reply back to all WebSocket clients
        this.bus.publish({
          ts: Date.now(),
          type: 'chat-reply',
          payload: { text: result.output }
        });
      } else {
        // Send error response
        this.bus.publish({
          ts: Date.now(),
          type: 'chat-reply',
          payload: { text: 'Sorry, I encountered an error processing your message.' }
        });
      }
    } catch (error) {
      console.error('Error handling chat message:', error);
      
      // Send error response
      this.bus.publish({
        ts: Date.now(),
        type: 'chat-reply',
        payload: { text: 'Sorry, I encountered an error processing your message.' }
      });
    }
  }
}

// Inline vitest smoke test
// @ts-ignore - vitest adds this at runtime  
if (typeof import.meta.vitest !== 'undefined') {
  // @ts-ignore - vitest adds this at runtime
  const { test, expect } = import.meta.vitest;

  test('WorkflowEngine emits correct event sequence', async () => {
    const events: any[] = [];
    const mockBus = {
      publish: (event: any) => events.push(event),
      subscribe: () => () => {},
      history: () => [],
    } as unknown as ChimeraEventBus;

    const mockGeminiChat = {} as unknown as GeminiChat;

    const engine = new WorkflowEngine(mockBus, mockGeminiChat);
    await engine.run('test input');

    // Extract event payloads for easier testing
    const payloads = events.map(e => e.payload);

    // Verify event order: workflow‑start → 4 agent‑start/‑end pairs → workflow‑complete
    expect(payloads[0]).toBe('workflow-start');
    expect(payloads[1]).toBe('agent-start-KERNEL');
    expect(payloads[2]).toContain('State transition:'); // from state machine advance
    expect(payloads[3]).toBe('agent-end-KERNEL');
    expect(payloads[4]).toBe('agent-start-SYNTH');
    expect(payloads[5]).toContain('State transition:');
    expect(payloads[6]).toBe('agent-end-SYNTH');
    expect(payloads[7]).toBe('agent-start-DRIVE');
    expect(payloads[8]).toContain('State transition:');
    expect(payloads[9]).toBe('agent-end-DRIVE');
    expect(payloads[10]).toBe('agent-start-AUDIT');
    expect(payloads[11]).toContain('State transition:');
    expect(payloads[12]).toBe('agent-end-AUDIT');
    expect(payloads[13]).toBe('workflow-complete');

    // Verify we have exactly 4 agent-start events
    const agentStartEvents = payloads.filter(p => typeof p === 'string' && p.startsWith('agent-start-'));
    expect(agentStartEvents).toHaveLength(4);

    // Verify we have exactly 4 agent-end events
    const agentEndEvents = payloads.filter(p => typeof p === 'string' && p.startsWith('agent-end-'));
    expect(agentEndEvents).toHaveLength(4);
  });
}
