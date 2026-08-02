import type { AgentDecision } from './decision.js';
import type { AgentTransactionSnapshot } from './snapshot.js';
import type {
  AgentToolCall,
  AgentToolName,
  AgentToolResult,
} from './tools.js';

export type AgentModelProvider = 'openrouter' | 'custom' | 'fake';
export type AgentModelErrorClassification = 'retryable' | 'terminal';
export const AGENT_MODEL_PROMPT_VERSION = 'agent-model-v1' as const;
export const agentModelPromptVersion = AGENT_MODEL_PROMPT_VERSION;

export interface AgentModelIdentity {
  readonly provider: AgentModelProvider;
  readonly model: string;
}

export interface AgentModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface AgentModelAssistantHistory {
  readonly role: 'assistant';
  readonly toolCalls: readonly AgentToolCall[];
}

export interface AgentModelToolHistory {
  readonly role: 'tool';
  readonly toolCallId: string;
  readonly name: AgentToolName;
  readonly result: AgentToolResult;
}

export type AgentModelHistoryEntry =
  | AgentModelAssistantHistory
  | AgentModelToolHistory;

interface AgentModelInputBase {
  readonly snapshot: AgentTransactionSnapshot;
  readonly history: readonly AgentModelHistoryEntry[];
}

export interface AgentModelDecisionInput extends AgentModelInputBase {
  readonly kind: 'decision';
}

export interface AgentModelReviewInput extends AgentModelInputBase {
  readonly kind: 'review';
  readonly candidateDecision: AgentDecision;
}

export type AgentModelInput = AgentModelDecisionInput | AgentModelReviewInput;

interface AgentModelTurnMetadata {
  readonly usage?: AgentModelUsage;
}

export interface AgentModelToolCallsTurn extends AgentModelTurnMetadata {
  readonly kind: 'tool_calls';
  readonly toolCalls: readonly AgentToolCall[];
}

export interface AgentModelDecisionTurn extends AgentModelTurnMetadata {
  readonly kind: 'decision';
  /** Raw JSON envelope; the runner applies parseAgentDecision after the turn. */
  readonly rawDecision: unknown;
}

export type AgentModelTurn =
  | AgentModelToolCallsTurn
  | AgentModelDecisionTurn;

export type AgentModelErrorCode =
  | 'AGENT_MODEL_CONFIG_INVALID'
  | 'AGENT_MODEL_INPUT_INVALID'
  | 'AGENT_MODEL_NETWORK_ERROR'
  | 'AGENT_MODEL_HTTP_ERROR'
  | 'AGENT_MODEL_RESPONSE_TOO_LARGE'
  | 'AGENT_MODEL_RESPONSE_INVALID'
  | 'AGENT_MODEL_ABORTED'
  | 'AGENT_MODEL_EXHAUSTED';

const ERROR_MESSAGES: Readonly<Record<AgentModelErrorCode, string>> = {
  AGENT_MODEL_CONFIG_INVALID: 'Invalid agent model configuration.',
  AGENT_MODEL_INPUT_INVALID: 'Invalid agent model input.',
  AGENT_MODEL_NETWORK_ERROR: 'Agent model request failed.',
  AGENT_MODEL_HTTP_ERROR: 'Agent model request failed.',
  AGENT_MODEL_RESPONSE_TOO_LARGE: 'Agent model response exceeds the byte limit.',
  AGENT_MODEL_RESPONSE_INVALID: 'Invalid agent model response.',
  AGENT_MODEL_ABORTED: 'Agent model request aborted.',
  AGENT_MODEL_EXHAUSTED: 'Fake agent model sequence exhausted.',
};

export class AgentModelError extends Error {
  constructor(
    readonly code: AgentModelErrorCode,
    readonly classification: AgentModelErrorClassification,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AgentModelError';
  }

  get retryable(): boolean {
    return this.classification === 'retryable';
  }
}

export interface AgentModel {
  readonly identity: AgentModelIdentity;
  nextTurn(input: AgentModelInput, signal: AbortSignal): Promise<AgentModelTurn>;
}
