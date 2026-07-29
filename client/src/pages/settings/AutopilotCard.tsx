import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Role } from '@recat/shared';
import {
  autopilot,
  type AutopilotOverviewDto,
  type AutopilotRunDto,
  type AutopilotSettingsPatch,
} from '../../lib/api';
import { useApp } from '../../state/AppContext';

const VERIFIER_LABEL = {
  deterministic: 'Deterministic checks',
  same_model: 'Same-model critique',
  distinct_model: 'Distinct-model review',
  unavailable: 'Verification unavailable',
} as const;

const cardStyle = {
  border: '1px solid var(--bd2)',
  borderRadius: 10,
  background: 'var(--card)',
  padding: '20px 24px',
  boxShadow: '0 1px 6px rgba(60,55,45,.05)',
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load shadow operations';
}

function numberField(form: FormData, name: string): number {
  return Number(form.get(name));
}

function settingsPatch(form: FormData): AutopilotSettingsPatch {
  return {
    mode: form.get('mode') === 'shadow' ? 'shadow' : 'off',
    provider: form.get('provider') === 'openrouter' ? 'openrouter' : 'custom',
    decisionModel: String(form.get('decisionModel') ?? ''),
    verifierModel: String(form.get('verifierModel') ?? ''),
    scheduleMinutes: numberField(form, 'scheduleMinutes'),
    companyConcurrency: numberField(form, 'companyConcurrency'),
    evidenceThreshold: numberField(form, 'evidenceThreshold'),
    limits: {
      maxToolCalls: numberField(form, 'maxToolCalls'),
      maxTurns: numberField(form, 'maxTurns'),
      maxContextBytes: numberField(form, 'maxContextBytes'),
      maxResponseBytes: numberField(form, 'maxResponseBytes'),
      timeoutMs: numberField(form, 'timeoutMs'),
    },
  };
}

function Field({
  label,
  name,
  defaultValue,
  min,
  max,
}: {
  label: string;
  name: string;
  defaultValue: number;
  min: number;
  max: number;
}) {
  return (
    <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
      {label}
      <input
        className="input"
        aria-label={label}
        name={name}
        type="number"
        defaultValue={defaultValue}
        min={min}
        max={max}
        required
        style={{ width: '100%' }}
      />
    </label>
  );
}

function VerifierGuide() {
  return (
    <div
      aria-label="Verifier kinds"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}
    >
      {Object.values(VERIFIER_LABEL).map((label) => (
        <span
          key={label}
          style={{
            border: '1px solid var(--bd2)',
            borderRadius: 99,
            padding: '3px 9px',
            fontSize: 11.5,
            color: 'var(--mut)',
          }}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function EvidenceProgress({ state }: { state: AutopilotOverviewDto }) {
  const { evidence } = state;
  const agreementRate = evidence.eligibleRuns === 0
    ? null
    : Math.round((evidence.agreements / evidence.eligibleRuns) * 100);
  return (
    <div style={{ minWidth: 190 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {evidence.eligibleRuns} of {evidence.threshold} qualified outcomes
      </div>
      <div
        role="progressbar"
        aria-label="Qualified evidence progress"
        aria-valuemin={0}
        aria-valuemax={evidence.threshold}
        aria-valuenow={Math.min(evidence.eligibleRuns, evidence.threshold)}
        style={{
          height: 7,
          background: 'var(--hl)',
          borderRadius: 99,
          overflow: 'hidden',
          marginTop: 7,
        }}
      >
        <div
          style={{
            width: `${Math.min(100, (evidence.eligibleRuns / evidence.threshold) * 100)}%`,
            height: '100%',
            background: evidence.thresholdMet ? 'var(--okT)' : 'var(--acc)',
          }}
        />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 5 }}>
        {agreementRate === null
          ? 'No qualified comparison outcomes yet'
          : `${agreementRate}% agreement · ${evidence.disagreements} disagreements`}
      </div>
    </div>
  );
}

function RunSummary({ run }: { run: AutopilotRunDto }) {
  const proposal = run.proposal;
  const evidence = run.verification.evidence;
  const outcome = proposal?.kind === 'proposal'
    ? `${proposal.lineCount} line proposal · ${Math.round(proposal.confidence * 100)}% confidence`
    : proposal?.kind === 'abstain'
      ? `Abstained · ${proposal.reasonCode.replaceAll('_', ' ').toLowerCase()}`
      : 'No safe proposal summary';
  const evidenceLabel = evidence?.state === 'eligible'
    ? evidence.agreement
      ? 'Qualified agreement'
      : 'Qualified disagreement'
    : evidence?.state === 'invalidated'
      ? `Evidence invalidated · ${evidence.invalidationReason}`
      : 'Not qualified as evidence';
  return (
    <li
      style={{
        listStyle: 'none',
        padding: '11px 0',
        borderTop: '1px solid var(--rowbd)',
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {run.status} · {outcome}
        </div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
          Verifier: {VERIFIER_LABEL[run.verification.verifierKind]} · {evidenceLabel}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 3 }}>
          Attempt {run.attemptCount} · config {run.configVersion}
        </div>
        {proposal?.kind === 'proposal' && (
          <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 3 }}>
            {proposal.taxCalculation} · evidence{' '}
            {proposal.evidenceKinds.length === 0 ? 'none' : proposal.evidenceKinds.join(', ')}
          </div>
        )}
        {run.verification.diagnosticCode && (
          <div style={{ fontSize: 11.5, color: 'var(--fnt)', marginTop: 3 }}>
            {run.verification.diagnosticCode}
          </div>
        )}
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--fnt)',
            marginTop: 3,
            overflowWrap: 'anywhere',
          }}
        >
          {run.models.decision} → {run.models.verifier} · prompt {run.models.promptVersion} ·
          schema {run.models.schemaVersion}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--fnt)', textAlign: 'right' }}>
        <div>Started {run.timing.createdAt}</div>
        <div>Completed {run.timing.completedAt ?? 'not completed'}</div>
        <div>{run.timing.durationMs === null ? '—' : `${run.timing.durationMs} ms`}</div>
        <div>
          input {run.usage?.inputTokens ?? '—'} · output {run.usage?.outputTokens ?? '—'} · total{' '}
          {run.usage?.totalTokens ?? '—'} tokens
        </div>
        {run.errorCode && <div style={{ color: 'var(--erT)' }}>{run.errorCode}</div>}
      </div>
    </li>
  );
}

export default function AutopilotCard({
  companyId,
  role,
}: {
  companyId: string;
  role: Exclude<Role, 'viewer'>;
}) {
  const { toast } = useApp();
  const [state, setState] = useState<AutopilotOverviewDto | null>(null);
  const [runs, setRuns] = useState<AutopilotRunDto[]>([]);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const generationRef = useRef(0);
  const isAdmin = role === 'admin';

  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    setState(null);
    setRuns([]);
    setLoadingError(null);
    setSaving(false);
    setCancelling(false);
    Promise.all([
      autopilot.get(companyId),
      autopilot.listRuns(companyId, { limit: 10 }),
    ])
      .then(([nextState, page]) => {
        if (cancelled || generationRef.current !== generation) return;
        setState(nextState);
        setRuns(page.runs);
      })
      .catch((error) => {
        if (!cancelled && generationRef.current === generation) {
          setLoadingError(errorMessage(error));
        }
      });
    return () => {
      cancelled = true;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [companyId]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!state || saving) return;
    const generation = generationRef.current;
    setSaving(true);
    try {
      const updated = await autopilot.patch(companyId, settingsPatch(new FormData(event.currentTarget)));
      if (generationRef.current !== generation) return;
      setState((current) => current === null ? current : { ...current, settings: updated });
      toast('Shadow autopilot settings saved');
    } catch (error) {
      if (generationRef.current === generation) toast(errorMessage(error));
    } finally {
      if (generationRef.current === generation) setSaving(false);
    }
  };

  const cancelQueued = async () => {
    if (cancelling) return;
    const generation = generationRef.current;
    setCancelling(true);
    try {
      const result = await autopilot.cancelQueued(companyId);
      if (generationRef.current !== generation) return;
      setState((current) => current === null
        ? current
        : {
            ...current,
            queue: {
              ...current.queue,
              queued: 0,
              retrying: 0,
              cancelled: current.queue.cancelled + result.cancelled,
              earliestDueAt: null,
            },
          });
      toast(`${result.cancelled} queued shadow job${result.cancelled === 1 ? '' : 's'} cancelled`);
    } catch (error) {
      if (generationRef.current === generation) toast(errorMessage(error));
    } finally {
      if (generationRef.current === generation) setCancelling(false);
    }
  };

  if (loadingError) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Shadow autopilot</div>
        <div role="alert" style={{ color: 'var(--erT)', marginTop: 6, fontSize: 13 }}>
          {loadingError}
        </div>
      </div>
    );
  }
  if (state === null) {
    return (
      <div style={cardStyle} aria-busy="true">
        <div style={{ fontSize: 15, fontWeight: 600 }}>Shadow autopilot</div>
        <div style={{ color: 'var(--mut)', marginTop: 6, fontSize: 13 }}>Loading operations…</div>
      </div>
    );
  }

  const { settings, queue } = state;
  return (
    <section style={cardStyle} aria-labelledby="autopilot-title">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 18,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 360px' }}>
          <div id="autopilot-title" style={{ fontSize: 15, fontWeight: 600 }}>
            Shadow autopilot
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
            Evaluates pending transactions in the background for inspection only. Shadow results
            cannot categorize or change QuickBooks.
          </div>
          <VerifierGuide />
          <div style={{ fontSize: 12, color: 'var(--fnt)', marginTop: 7 }}>
            Same-model results never count toward the evidence threshold; only qualified
            distinct-model outcomes do.
          </div>
        </div>
        <EvidenceProgress state={state} />
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          marginTop: 16,
          padding: '10px 12px',
          background: 'var(--hl)',
          borderRadius: 8,
          fontSize: 12.5,
          color: 'var(--mut)',
        }}
      >
        <span>{settings.mode === 'shadow' ? 'Shadow enabled' : 'Shadow off'}</span>
        <span>{queue.queued} queued</span>
        <span>{queue.running} running</span>
        <span>{queue.retrying} retrying</span>
        <span>{queue.terminal} terminal</span>
        <span>{queue.cancelled} cancelled</span>
        {queue.earliestLeaseExpiryAt && (
          <span>
            Earliest lease expiry{' '}
            {new Date(queue.earliestLeaseExpiryAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {isAdmin ? (
        <form key={settings.configVersion} onSubmit={(event) => void save(event)} style={{ marginTop: 18 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
              gap: 10,
            }}
          >
            <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
              Mode
              <select className="select" name="mode" defaultValue={settings.mode}>
                <option value="off">Off</option>
                <option value="shadow">Shadow</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
              Provider
              <select className="select" name="provider" defaultValue={settings.provider}>
                <option value="custom">Custom</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
              Decision model
              <input
                className="input"
                name="decisionModel"
                defaultValue={settings.decisionModel}
                maxLength={200}
                required
              />
            </label>
            <label style={{ display: 'grid', gap: 5, fontSize: 12.5, color: 'var(--mut)' }}>
              Verifier model
              <input
                className="input"
                name="verifierModel"
                defaultValue={settings.verifierModel}
                maxLength={200}
                required
              />
            </label>
            <Field
              label="Schedule (minutes)"
              name="scheduleMinutes"
              defaultValue={settings.scheduleMinutes}
              min={1}
              max={1_440}
            />
            <Field
              label="Company concurrency"
              name="companyConcurrency"
              defaultValue={settings.companyConcurrency}
              min={1}
              max={4}
            />
            <Field
              label="Evidence threshold"
              name="evidenceThreshold"
              defaultValue={settings.evidenceThreshold}
              min={25}
              max={1_000}
            />
            <Field
              label="Tool-call limit"
              name="maxToolCalls"
              defaultValue={settings.limits.maxToolCalls}
              min={1}
              max={8}
            />
            <Field
              label="Turn limit"
              name="maxTurns"
              defaultValue={settings.limits.maxTurns}
              min={1}
              max={4}
            />
            <Field
              label="Context bytes"
              name="maxContextBytes"
              defaultValue={settings.limits.maxContextBytes}
              min={1}
              max={65_536}
            />
            <Field
              label="Response bytes"
              name="maxResponseBytes"
              defaultValue={settings.limits.maxResponseBytes}
              min={1}
              max={32_768}
            />
            <Field
              label="Timeout (ms)"
              name="timeoutMs"
              defaultValue={settings.limits.timeoutMs}
              min={1}
              max={30_000}
            />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              marginTop: 14,
            }}
          >
            <button className="btn-ghost" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save shadow settings'}
            </button>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: 'var(--fnt)' }}>
                Running leases are not interrupted and run history is kept.
              </span>
              <button
                className="btn-ghost"
                type="button"
                disabled={cancelling}
                onClick={() => void cancelQueued()}
              >
                {cancelling ? 'Cancelling queued work…' : 'Cancel queued and retrying work'}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div style={{ marginTop: 14, color: 'var(--fnt)', fontSize: 12.5 }}>
          Company administrators manage shadow scheduling and queue cancellation.
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>Recent safe run summaries</div>
        {runs.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--mut)', marginTop: 7 }}>
            No shadow runs yet.
          </div>
        ) : (
          <ul aria-label="Recent shadow runs" style={{ margin: '7px 0 0', padding: 0 }}>
            {runs.map((run) => <RunSummary key={run.id} run={run} />)}
          </ul>
        )}
      </div>
    </section>
  );
}

export function AutopilotQueueStatus({ companyId }: { companyId: string }) {
  const [state, setState] = useState<AutopilotOverviewDto | null>(null);
  const [runs, setRuns] = useState<AutopilotRunDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    setState(null);
    setRuns([]);
    setNextCursor(null);
    setLoadingOlder(false);
    Promise.all([
      autopilot.get(companyId),
      autopilot.listRuns(companyId, { limit: 5 })
        .catch(() => ({ runs: [], nextCursor: null })),
    ])
      .then(([nextState, page]) => {
        if (cancelled || generationRef.current !== generation) return;
        setState(nextState);
        setRuns(page.runs);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        // Queue operations are supplementary; categorization remains available.
      });
    return () => {
      cancelled = true;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [companyId]);

  const loadOlder = async () => {
    if (nextCursor === null || loadingOlder) return;
    const generation = generationRef.current;
    setLoadingOlder(true);
    try {
      const page = await autopilot.listRuns(companyId, { limit: 5, cursor: nextCursor });
      if (generationRef.current !== generation) return;
      setRuns((current) => {
        const ids = new Set(current.map((run) => run.id));
        return [...current, ...page.runs.filter((run) => !ids.has(run.id))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      // Keep the current page and cursor so a supplementary history read can be retried.
    } finally {
      if (generationRef.current === generation) setLoadingOlder(false);
    }
  };

  if (state === null) return null;
  return (
    <aside
      aria-label="Shadow autopilot status"
      style={{
        ...cardStyle,
        padding: '12px 16px',
        marginBottom: 14,
        display: 'grid',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Shadow autopilot</div>
          <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
            {state.queue.queued} queued · {state.queue.running} running ·{' '}
            {state.queue.retrying} retrying
          </div>
        </div>
        <EvidenceProgress state={state} />
      </div>
      {runs.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>No shadow runs yet.</div>
      ) : (
        <ul aria-label="Recent shadow runs" style={{ margin: 0, padding: 0 }}>
          {runs.map((run) => <RunSummary key={run.id} run={run} />)}
        </ul>
      )}
      {nextCursor !== null && (
        <button
          className="btn-ghost"
          type="button"
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
          style={{ justifySelf: 'start' }}
        >
          {loadingOlder ? 'Loading older runs…' : 'Load older runs'}
        </button>
      )}
    </aside>
  );
}
