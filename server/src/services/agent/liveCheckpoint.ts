import {
  agentDecisionSchemaVersion,
  parseAgentDecision,
} from './core/decision.js';
import { AGENT_MODEL_PROMPT_VERSION } from './core/model.js';

export interface LiveCheckpointBinding {
  readonly snapshotRevision: number;
  readonly decisionModel: string;
  readonly verifierModel: string;
}

export function isCanonicalLiveCheckpoint(
  value: unknown,
  binding: LiveCheckpointBinding,
): boolean {
  const checkpoint = runtimeRecord(value);
  const result = runtimeRecord(checkpoint?.result);
  const verification = runtimeRecord(checkpoint?.verification);
  const proof = runtimeRecord(checkpoint?.proof);
  const identity = runtimeRecord(verification?.liveIdentityProof);
  if (
    checkpoint?.version !== 1
    || result?.status !== 'verified'
    || result.snapshotRevision !== binding.snapshotRevision
    || result.decisionModel !== binding.decisionModel
    || !boundedText(result.decisionProvider)
    || !boundedText(binding.verifierModel)
    || result.promptVersion !== AGENT_MODEL_PROMPT_VERSION
    || result.schemaVersion !== agentDecisionSchemaVersion
    || result.verificationMode !== 'distinct_model'
    || result.diagnosticCode !== 'AGENT_RUN_VERIFIED'
    || verification?.ok !== true
    || verification.code !== 'AGENT_DECISION_VERIFIED'
    || identity?.version !== 1
    || !boundedText(identity.providerBinding)
    || !boundedText(identity.decisionIdentity)
    || !boundedText(identity.verifierIdentity)
    || identity.decisionIdentity === identity.verifierIdentity
    || proof?.providerBinding !== identity.providerBinding
    || typeof proof.taxAuthorityDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(proof.taxAuthorityDigest)
  ) return false;
  const resultDecision = proposal(result.decision);
  const verifiedDecision = proposal(verification.decision);
  return resultDecision !== null
    && verifiedDecision !== null
    && canonicalJson(resultDecision) === canonicalJson(verifiedDecision);
}

function proposal(value: unknown): unknown | null {
  try {
    const decision = parseAgentDecision({ decision: value });
    return decision.kind === 'proposal' ? decision : null;
  } catch {
    return null;
  }
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.length <= 200;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
