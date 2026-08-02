import {
  AgentModelError,
  type AgentModel,
  type AgentModelIdentity,
  type AgentModelInput,
  type AgentModelTurn,
} from './model.js';

export class FakeAgentModel implements AgentModel {
  readonly identity: AgentModelIdentity;
  private readonly turns: readonly AgentModelTurn[];
  private nextIndex = 0;

  constructor(turns: readonly AgentModelTurn[], model = 'fake') {
    this.identity = Object.freeze({ provider: 'fake', model });
    this.turns = turns.map((turn) => detachedTurn(turn));
  }

  async nextTurn(_input: AgentModelInput, signal: AbortSignal): Promise<AgentModelTurn> {
    if (signal.aborted) {
      throw new AgentModelError('AGENT_MODEL_ABORTED', 'terminal');
    }
    const turn = this.turns[this.nextIndex];
    if (turn === undefined) {
      throw new AgentModelError('AGENT_MODEL_EXHAUSTED', 'terminal');
    }
    this.nextIndex += 1;
    return detachedTurn(turn);
  }
}

function detachedTurn(turn: AgentModelTurn): AgentModelTurn {
  return deepFreeze(structuredClone(turn));
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
