import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClassificationCase,
  RuleCandidateDto,
  RuleDetailDto,
  RuleLifecycleFilter,
  RuleMutationKind,
  RuleMutationResult,
  RuleRevisionReadDto,
  RuleTestResult,
} from '@recat/shared';
import { isQboHoldingAccountName } from '@recat/shared';
import { Link } from 'react-router-dom';
import {
  classificationMemory,
  createCategorizationRequestId,
  ruleCandidates as ruleCandidatesApi,
  ruleOperations,
  rules as rulesApi,
  type PrepareRuleOperationBody,
} from '../lib/api';
import ClassificationMemoryPanel from '../components/ClassificationMemoryPanel';
import ConfirmDialog from '../components/ConfirmDialog';
import { Combobox, Select } from '../components/SelectCombobox';
import { fmtDate, fmtMoney } from '../lib/format';
import { useApp } from '../state/AppContext';

const PAGE_SIZE = 100;
const HISTORY_WINDOW_SIZE = 100;
const MAX_VISIBLE_RULES = 200;
const MAX_VISIBLE_CANDIDATES = 100;
const MAX_REORDER_PAGES = 20;
const buttonStyle = {
  border: '1px solid var(--bd)', background: 'var(--card)', color: 'var(--ink)',
  borderRadius: 7, padding: '7px 10px', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
} as const;

type PreparedIntent = {
  result: RuleMutationResult;
  idempotencyKey: string;
  confirmLabel: string;
  successMessage: string;
  candidateId: string | null;
};

type PendingPreparation = {
  body: PrepareRuleOperationBody;
  candidateId: string | null;
};

type HistoryState = {
  items: RuleRevisionReadDto[];
  olderExists: boolean;
  busy: boolean;
};

function readable(value: string): string {
  return value.replaceAll('_', ' ');
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

function revisionChanges(
  current: RuleRevisionReadDto,
  previous?: RuleRevisionReadDto,
  olderComparisonUnavailable = false,
): string {
  if (!previous) {
    return olderComparisonUnavailable
      ? 'Older comparison unavailable — history is truncated.'
      : 'Initial recorded revision.';
  }
  const changes: string[] = [];
  if (previous.state !== current.state) changes.push(`state ${previous.state} → ${current.state}`);
  if (previous.condition.matchField !== current.condition.matchField) {
    changes.push(`match field ${previous.condition.matchField} → ${current.condition.matchField}`);
  }
  if (previous.condition.matchText !== current.condition.matchText) {
    changes.push(`match ${previous.condition.matchText} → ${current.condition.matchText}`);
  }
  if (previous.categoryName !== current.categoryName) changes.push(`category ${previous.categoryName} → ${current.categoryName}`);
  if ((previous.action?.categoryQboId ?? null) !== (current.action?.categoryQboId ?? null)) {
    changes.push(`category QBO ID ${previous.action?.categoryQboId ?? 'none'} → ${current.action?.categoryQboId ?? 'none'}`);
  }
  if ((previous.action?.taxCalculation ?? null) !== (current.action?.taxCalculation ?? null)) {
    changes.push(`tax calculation ${previous.action?.taxCalculation ?? 'none'} → ${current.action?.taxCalculation ?? 'none'}`);
  }
  if (previous.taxCodeName !== current.taxCodeName) changes.push(`tax code ${previous.taxCodeName ?? 'none'} → ${current.taxCodeName ?? 'none'}`);
  if ((previous.action?.taxCodeQboId ?? null) !== (current.action?.taxCodeQboId ?? null)) {
    changes.push(`tax code QBO ID ${previous.action?.taxCodeQboId ?? 'none'} → ${current.action?.taxCodeQboId ?? 'none'}`);
  }
  const previousTags = previous.action?.tagIds ?? [];
  const currentTags = current.action?.tagIds ?? [];
  if (JSON.stringify(previousTags) !== JSON.stringify(currentTags)) {
    changes.push(`tag order ${previousTags.join(', ') || 'none'} → ${currentTags.join(', ') || 'none'}`);
  }
  if (previous.priority !== current.priority) changes.push(`priority ${previous.priority} → ${current.priority}`);
  if (previous.autoPost !== current.autoPost) changes.push(`auto-post ${onOff(previous.autoPost)} → ${onOff(current.autoPost)}`);
  if (previous.valid !== current.valid) changes.push(`validity ${previous.valid ? 'valid' : 'invalid'} → ${current.valid ? 'valid' : 'invalid'}`);
  if (JSON.stringify(previous.invalidReasons) !== JSON.stringify(current.invalidReasons)) changes.push('invalid reasons changed');
  if (previous.originIntent !== current.originIntent) {
    changes.push(`origin intent ${previous.originIntent ? readable(previous.originIntent) : 'none'} → ${current.originIntent ? readable(current.originIntent) : 'none'}`);
  }
  if (previous.sourceCaseId !== current.sourceCaseId) changes.push(`source case ${previous.sourceCaseId ?? 'none'} → ${current.sourceCaseId ?? 'none'}`);
  if (previous.sourceCandidateId !== current.sourceCandidateId) changes.push(`source candidate ${previous.sourceCandidateId ?? 'none'} → ${current.sourceCandidateId ?? 'none'}`);
  if (previous.changedBy !== current.changedBy) changes.push(`actor ${previous.changedBy ?? 'none'} → ${current.changedBy ?? 'none'}`);
  if (previous.retiredAt !== current.retiredAt) changes.push(`retired at ${previous.retiredAt ?? 'none'} → ${current.retiredAt ?? 'none'}`);
  return changes.length > 0 ? `Changed: ${changes.join(' · ')}` : 'No material classification fields changed.';
}

function operationLabels(
  mutation: RuleMutationKind,
  autoPost?: boolean,
): Pick<PreparedIntent, 'confirmLabel' | 'successMessage'> {
  if (mutation === 'activate_candidate') {
    return { confirmLabel: 'Confirm activate candidate', successMessage: 'Rule activated — auto-post remains off' };
  }
  if (mutation === 'dismiss_candidate') {
    return { confirmLabel: 'Confirm dismiss candidate', successMessage: 'Rule candidate dismissed' };
  }
  if (mutation === 'reorder') {
    return { confirmLabel: 'Confirm reorder rules', successMessage: 'Rule order updated' };
  }
  if (mutation === 'update' && autoPost !== undefined) {
    return autoPost
      ? { confirmLabel: 'Confirm enable auto-post', successMessage: 'Auto-post enabled' }
      : { confirmLabel: 'Confirm disable auto-post', successMessage: 'Auto-post disabled' };
  }
  if (mutation === 'update') {
    return { confirmLabel: 'Confirm update rule', successMessage: 'Rule updated' };
  }
  return {
    confirmLabel: `Confirm ${mutation} rule`,
    successMessage: mutation === 'retire'
      ? 'Rule retired'
      : `Rule ${mutation === 'enable' ? 'enabled' : 'disabled'}`,
  };
}

function PreviewBody({ operation }: { operation: PreparedIntent }) {
  const preview = operation.result.preview;
  if (!preview) return null;
  return (
    <div>
      <p style={{ margin: '0 0 8px' }}>
        <strong>{preview.condition.matchText}</strong> → {preview.categoryName}
        {' · '}{readable(preview.action?.taxCalculation ?? 'advisory only')}
        {preview.taxCodeName ? ` · ${preview.taxCodeName}` : ''}
      </p>
      <p style={{ margin: '0 0 8px' }}>
        {preview.affectedPendingCount} pending · {preview.affectedPostedCount} posted
      </p>
      <p style={{ margin: '0 0 8px' }}>Auto-post: <strong>{preview.autoPost ? 'on' : 'off'}</strong></p>
      {preview.warnings.slice(0, 10).map((warning) => (
        <div key={warning} role="alert" style={{ color: 'var(--amT)', marginTop: 5 }}>{warning}</div>
      ))}
      {preview.conflicts.slice(0, 10).map((conflict) => (
        <div key={conflict.id} role="alert" style={{ color: 'var(--erT)', marginTop: 5 }}>{conflict.reason}</div>
      ))}
      {preview.sampleTransactions.length > 0 && (
        <ul style={{ paddingLeft: 20, marginBottom: 0 }}>
          {preview.sampleTransactions.slice(0, 20).map((sample) => (
            <li key={sample.transactionId}>
              {sample.payee} · {fmtDate(sample.date)} · {fmtMoney(sample.amountCents / 100)} · {sample.status.toLowerCase()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Rules() {
  const { activeCompanyId, activeCompany, accounts, tags, toast } = useApp();
  const [filter, setFilter] = useState<RuleLifecycleFilter>('all');
  const [ruleList, setRuleList] = useState<RuleDetailDto[]>([]);
  const [ruleCursor, setRuleCursor] = useState<string | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rulesTruncated, setRulesTruncated] = useState(false);
  const [candidateList, setCandidateList] = useState<RuleCandidateDto[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [candidatesTruncated, setCandidatesTruncated] = useState(false);
  const [reorderRules, setReorderRules] = useState<RuleDetailDto[]>([]);
  const [reorderReady, setReorderReady] = useState(false);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedIntent | null>(null);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [history, setHistory] = useState<Record<string, HistoryState>>({});
  const [testResult, setTestResult] = useState<Record<string, RuleTestResult>>({});
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [sourceCase, setSourceCase] = useState<ClassificationCase | null>(null);
  const [sourceRule, setSourceRule] = useState<RuleDetailDto | null>(null);
  const [sourceCandidate, setSourceCandidate] = useState<RuleCandidateDto | null>(null);
  const companyRef = useRef(activeCompanyId);
  const rulePageRequestRef = useRef(0);
  const candidatePageRequestRef = useRef(0);
  const reorderRequestRef = useRef(0);
  const operationRequestRef = useRef(0);
  const historyRequestRef = useRef<Record<string, number>>({});
  const preparingRef = useRef(false);
  const pendingPreparationRef = useRef<PendingPreparation | null>(null);
  const ruleListRef = useRef<RuleDetailDto[]>([]);
  const candidateListRef = useRef<RuleCandidateDto[]>([]);
  companyRef.current = activeCompanyId;
  ruleListRef.current = ruleList;
  candidateListRef.current = candidateList;

  const categoryOptions = useMemo(() => {
    const holdingIds = new Set((activeCompany?.holdingAccountIds ?? []).map(String));
    return accounts
      .filter((account) => (
        account.classification === 'Income' ||
        account.classification === 'COGS' ||
        account.classification === 'Expenses'
      ) && !holdingIds.has(account.id) && !holdingIds.has(account.qboId) && !isQboHoldingAccountName(account.name))
      .map((account) => ({ qboId: account.qboId, label: `${account.classification} · ${account.name}` }));
  }, [accounts, activeCompany]);

  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag.name])), [tags]);

  const loadFirstPage = useCallback(async (companyId: string, state: RuleLifecycleFilter) => {
    const requestId = ++rulePageRequestRef.current;
    setRulesBusy(true);
    setRulesError(null);
    setRulesTruncated(false);
    try {
      const page = await rulesApi.lifecycle(companyId, state, undefined, PAGE_SIZE);
      if (requestId !== rulePageRequestRef.current || companyRef.current !== companyId) return;
      const items = page.items.slice(0, MAX_VISIBLE_RULES);
      const truncated = page.items.length > MAX_VISIBLE_RULES
        || (items.length >= MAX_VISIBLE_RULES && page.nextCursor !== null);
      ruleListRef.current = items;
      setRuleList(items);
      setRulesTruncated(truncated);
      setRuleCursor(truncated ? null : page.nextCursor);
    } catch (error) {
      if (requestId === rulePageRequestRef.current && companyRef.current === companyId) {
        setRulesError(error instanceof Error ? error.message : 'Rules are unavailable.');
      }
    } finally {
      if (requestId === rulePageRequestRef.current && companyRef.current === companyId) setRulesBusy(false);
    }
  }, []);

  const loadCandidates = useCallback(async (companyId: string, cursor?: string, append = false) => {
    if (append && candidateListRef.current.length >= MAX_VISIBLE_CANDIDATES) return;
    const requestId = ++candidatePageRequestRef.current;
    setCandidateBusy(true);
    if (!append) {
      setCandidatesError(null);
      setCandidatesTruncated(false);
    }
    try {
      const page = cursor === undefined
        ? await ruleCandidatesApi.list(companyId)
        : await ruleCandidatesApi.list(companyId, cursor);
      if (requestId !== candidatePageRequestRef.current || companyRef.current !== companyId) return;
      const current = append ? candidateListRef.current : [];
      const existing = new Set(current.map((candidate) => candidate.id));
      const combined = [
        ...current,
        ...page.candidates.filter((candidate) => !existing.has(candidate.id)),
      ];
      const retained = combined.slice(0, MAX_VISIBLE_CANDIDATES);
      const truncated = combined.length > MAX_VISIBLE_CANDIDATES
        || (retained.length >= MAX_VISIBLE_CANDIDATES && page.nextCursor !== null);
      candidateListRef.current = retained;
      setCandidateList(retained);
      setCandidatesTruncated(truncated);
      setCandidateCursor(truncated ? null : page.nextCursor);
    } catch (error) {
      if (requestId === candidatePageRequestRef.current && companyRef.current === companyId) {
        setCandidatesError(error instanceof Error ? error.message : 'Rule candidates are unavailable.');
      }
    } finally {
      if (requestId === candidatePageRequestRef.current && companyRef.current === companyId) setCandidateBusy(false);
    }
  }, []);

  const loadReorderRules = useCallback(async (companyId: string) => {
    const requestId = ++reorderRequestRef.current;
    setReorderReady(false);
    setReorderBusy(true);
    setReorderError(null);
    const all: RuleDetailDto[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let pageNumber = 0; pageNumber < MAX_REORDER_PAGES; pageNumber += 1) {
        const page = await rulesApi.lifecycle(companyId, 'enabled', cursor, PAGE_SIZE);
        if (requestId !== reorderRequestRef.current || companyRef.current !== companyId) return;
        for (const rule of page.items) {
          if (!ids.has(rule.revision.ruleId)) {
            ids.add(rule.revision.ruleId);
            all.push(rule);
          }
        }
        if (!page.nextCursor) {
          setReorderRules(all);
          setReorderReady(true);
          return;
        }
        if (cursors.has(page.nextCursor)) throw new Error('The enabled rule cursor repeated; ordering was not loaded.');
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new Error(`More than ${MAX_REORDER_PAGES * PAGE_SIZE} enabled rules exist; ordering is unavailable.`);
    } catch (error) {
      if (requestId === reorderRequestRef.current && companyRef.current === companyId) {
        setReorderRules([]);
        setReorderError(error instanceof Error ? error.message : 'Rule ordering is unavailable.');
      }
    } finally {
      if (requestId === reorderRequestRef.current && companyRef.current === companyId) setReorderBusy(false);
    }
  }, []);

  useEffect(() => {
    const companyId = activeCompanyId;
    operationRequestRef.current += 1;
    rulePageRequestRef.current += 1;
    candidatePageRequestRef.current += 1;
    reorderRequestRef.current += 1;
    historyRequestRef.current = {};
    setRuleList([]);
    ruleListRef.current = [];
    setRuleCursor(null);
    setRulesError(null);
    setRulesTruncated(false);
    setCandidateList([]);
    candidateListRef.current = [];
    setCandidateCursor(null);
    setCandidatesError(null);
    setCandidatesTruncated(false);
    setReorderRules([]);
    setReorderReady(false);
    setReorderError(null);
    setPrepared(null);
    setPrepareBusy(false);
    setPrepareError(null);
    setCommitBusy(false);
    preparingRef.current = false;
    pendingPreparationRef.current = null;
    setHistory({});
    setTestResult({});
    setSourceCase(null);
    setSourceRule(null);
    setSourceCandidate(null);
    if (!companyId) return;
    void loadFirstPage(companyId, filter);
    void loadCandidates(companyId);
    void loadReorderRules(companyId);

    const source = new URLSearchParams(window.location.search);
    const sourceKind = source.get('source');
    const sourceId = source.get('sourceId');
    if (sourceKind === 'classification_case' && sourceId) {
      classificationMemory.getCase(companyId, sourceId)
        .then((classificationCase) => {
          if (companyRef.current === companyId) setSourceCase(classificationCase);
        })
        .catch((error: Error) => {
          if (companyRef.current === companyId) toast(error.message);
        });
    } else if (sourceKind === 'rule' && sourceId) {
      rulesApi.detail(companyId, sourceId)
        .then((rule) => {
          if (companyRef.current === companyId) setSourceRule(rule);
        })
        .catch((error: Error) => {
          if (companyRef.current === companyId) toast(error.message);
        });
    } else if (sourceKind === 'rule_candidate' && sourceId) {
      ruleCandidatesApi.get(companyId, sourceId)
        .then((candidate) => {
          if (companyRef.current === companyId) setSourceCandidate(candidate);
        })
        .catch((error: Error) => {
          if (companyRef.current === companyId) toast(error.message);
        });
    }
  }, [activeCompanyId, filter, loadCandidates, loadFirstPage, loadReorderRules, toast]);

  const loadMoreRules = useCallback(async () => {
    if (!activeCompanyId || !ruleCursor || rulesBusy || ruleListRef.current.length >= MAX_VISIBLE_RULES) return;
    const companyId = activeCompanyId;
    const requestId = ++rulePageRequestRef.current;
    setRulesBusy(true);
    try {
      const page = await rulesApi.lifecycle(companyId, filter, ruleCursor, PAGE_SIZE);
      if (requestId !== rulePageRequestRef.current || companyRef.current !== companyId) return;
      const current = ruleListRef.current;
      const ids = new Set(current.map((rule) => rule.revision.ruleId));
      const combined = [...current, ...page.items.filter((rule) => !ids.has(rule.revision.ruleId))];
      const retained = combined.slice(0, MAX_VISIBLE_RULES);
      const truncated = combined.length > MAX_VISIBLE_RULES
        || (retained.length >= MAX_VISIBLE_RULES && page.nextCursor !== null);
      ruleListRef.current = retained;
      setRuleList(retained);
      setRulesTruncated(truncated);
      setRuleCursor(truncated ? null : page.nextCursor);
    } catch (error) {
      if (requestId === rulePageRequestRef.current && companyRef.current === companyId) {
        toast(error instanceof Error ? error.message : 'Rules are unavailable.');
      }
    } finally {
      if (requestId === rulePageRequestRef.current && companyRef.current === companyId) setRulesBusy(false);
    }
  }, [activeCompanyId, filter, ruleCursor, rulesBusy, toast]);

  const runPreparation = useCallback(async (intent: PendingPreparation) => {
    if (!activeCompanyId || preparingRef.current || prepared || commitBusy) return;
    const companyId = activeCompanyId;
    preparingRef.current = true;
    setPrepareBusy(true);
    setPrepareError(null);
    const requestId = ++operationRequestRef.current;
    const labels = operationLabels(intent.body.mutation, intent.body.proposal?.autoPost);
    try {
      const result = await ruleOperations.prepare(companyId, intent.body);
      if (requestId !== operationRequestRef.current || companyRef.current !== companyId) return;
      if (!result.ok || !result.preview) {
        pendingPreparationRef.current = null;
        setPrepareError(result.error?.message ?? 'The server did not return a reviewable preview.');
        return;
      }
      setPrepared({ result, idempotencyKey: intent.body.idempotencyKey, candidateId: intent.candidateId, ...labels });
    } catch (error) {
      if (requestId === operationRequestRef.current && companyRef.current === companyId) {
        setPrepareError(error instanceof Error ? error.message : 'Rule preparation failed.');
      }
    } finally {
      if (requestId === operationRequestRef.current && companyRef.current === companyId) {
        preparingRef.current = false;
        setPrepareBusy(false);
      }
    }
  }, [activeCompanyId, commitBusy, prepared]);

  const beginOperation = useCallback((body: PrepareRuleOperationBody, candidateId: string | null = null) => {
    if (!activeCompanyId || prepared || commitBusy || preparingRef.current || pendingPreparationRef.current) return;
    const intent = { body, candidateId };
    pendingPreparationRef.current = intent;
    void runPreparation(intent);
  }, [activeCompanyId, commitBusy, prepared, runPreparation]);

  const startRuleOperation = useCallback((
    rule: RuleDetailDto,
    mutation: Exclude<RuleMutationKind, 'create' | 'activate_candidate' | 'dismiss_candidate' | 'reorder'>,
    proposal?: PrepareRuleOperationBody['proposal'],
  ) => {
    if (preparingRef.current || pendingPreparationRef.current || prepared || commitBusy) return;
    void beginOperation({
      mutation,
      ruleId: rule.revision.ruleId,
      expectedRevision: rule.revision.revision,
      idempotencyKey: createCategorizationRequestId(),
      ...(proposal === undefined ? {} : { proposal }),
    });
  }, [beginOperation, commitBusy, prepared]);

  const startCandidateOperation = useCallback((candidate: RuleCandidateDto, mutation: 'activate_candidate' | 'dismiss_candidate') => {
    if (preparingRef.current || pendingPreparationRef.current || prepared || commitBusy) return;
    void beginOperation({ mutation, candidateId: candidate.id, expectedRevision: 0, idempotencyKey: createCategorizationRequestId() }, candidate.id);
  }, [beginOperation, commitBusy, prepared]);

  const linkedSourceRule = sourceRule
    && !ruleList.some((rule) => rule.revision.ruleId === sourceRule.revision.ruleId)
    ? sourceRule
    : null;
  const linkedSourceCandidate = sourceCandidate
    && !candidateList.some((candidate) => candidate.id === sourceCandidate.id)
    ? sourceCandidate
    : null;
  const ruleGroups = [
    ...(linkedSourceRule ? [{ key: 'linked-source', linked: true, items: [linkedSourceRule] }] : []),
    { key: 'lifecycle-collection', linked: false, items: ruleList },
  ];
  const candidateGroups = [
    ...(linkedSourceCandidate ? [{ key: 'linked-source', linked: true, items: [linkedSourceCandidate] }] : []),
    { key: 'candidate-collection', linked: false, items: candidateList },
  ];
  const reorderRule = useCallback((rule: RuleDetailDto, direction: -1 | 1) => {
    if (!reorderReady || preparingRef.current || pendingPreparationRef.current || prepared || commitBusy) return;
    const ordered = reorderRules;
    const index = ordered.findIndex((row) => row.revision.ruleId === rule.revision.ruleId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    const changed = next.filter((row, priority) => row.revision.priority !== priority);
    if (changed.length === 0) return;
    void beginOperation({
      mutation: 'reorder',
      expectedRevision: Math.max(...changed.map((row) => row.revision.revision)),
      idempotencyKey: createCategorizationRequestId(),
      proposal: { orderIds: next.map((row) => row.revision.ruleId) },
    });
  }, [beginOperation, commitBusy, prepared, reorderReady, reorderRules]);

  const commitOperation = useCallback(async () => {
    if (!activeCompanyId || !prepared || commitBusy) return;
    const companyId = activeCompanyId;
    const current = prepared;
    const requestId = operationRequestRef.current;
    setCommitBusy(true);
    try {
      const result = await ruleOperations.commit(companyId, current.result.operationId, current.idempotencyKey);
      if (requestId !== operationRequestRef.current || companyRef.current !== companyId) return;
      if (!result.ok) throw new Error(result.error?.message ?? 'Rule operation failed.');
      setPrepared(null);
      pendingPreparationRef.current = null;
      setPrepareError(null);
      setSourceRule(null);
      setSourceCandidate(null);
      toast(current.successMessage);
      await Promise.all([
        loadFirstPage(companyId, filter),
        loadCandidates(companyId),
        loadReorderRules(companyId),
      ]);
    } catch (error) {
      if (requestId === operationRequestRef.current && companyRef.current === companyId) {
        toast(error instanceof Error ? error.message : 'Rule operation failed.');
      }
    } finally {
      if (requestId === operationRequestRef.current && companyRef.current === companyId) setCommitBusy(false);
    }
  }, [activeCompanyId, commitBusy, filter, loadCandidates, loadFirstPage, loadReorderRules, prepared, toast]);

  const viewHistory = useCallback(async (ruleId: string) => {
    if (!activeCompanyId || history[ruleId]?.busy) return;
    const companyId = activeCompanyId;
    const requestId = (historyRequestRef.current[ruleId] ?? 0) + 1;
    historyRequestRef.current[ruleId] = requestId;
    setHistory((current) => ({ ...current, [ruleId]: { items: current[ruleId]?.items ?? [], olderExists: current[ruleId]?.olderExists ?? false, busy: true } }));
    try {
      const page = await rulesApi.revisions(companyId, ruleId, undefined, HISTORY_WINDOW_SIZE);
      if (requestId !== historyRequestRef.current[ruleId] || companyRef.current !== companyId) return;
      setHistory((current) => ({
        ...current,
        [ruleId]: {
          items: page.items.slice(0, HISTORY_WINDOW_SIZE),
          olderExists: page.nextCursor !== null || page.items.length > HISTORY_WINDOW_SIZE,
          busy: false,
        },
      }));
    } catch (error) {
      if (requestId === historyRequestRef.current[ruleId] && companyRef.current === companyId) {
        setHistory((current) => ({ ...current, [ruleId]: { ...(current[ruleId] ?? { items: [], olderExists: false }), busy: false } }));
        toast(error instanceof Error ? error.message : 'Revision history is unavailable.');
      }
    }
  }, [activeCompanyId, history, toast]);

  const testRule = useCallback(async (rule: RuleDetailDto) => {
    if (!activeCompanyId || testBusy) return;
    const companyId = activeCompanyId;
    const ruleId = rule.revision.ruleId;
    setTestBusy(ruleId);
    try {
      const result = await rulesApi.test(companyId, rule.revision.condition.matchText);
      if (companyRef.current === companyId) setTestResult((current) => ({ ...current, [ruleId]: result }));
    } catch (error) {
      if (companyRef.current === companyId) toast(error instanceof Error ? error.message : 'Rule test failed.');
    } finally {
      if (companyRef.current === companyId) setTestBusy(null);
    }
  }, [activeCompanyId, testBusy, toast]);

  const cancelPreparation = useCallback(() => {
    if (commitBusy) return;
    operationRequestRef.current += 1;
    preparingRef.current = false;
    pendingPreparationRef.current = null;
    setPrepareBusy(false);
    setPrepareError(null);
    setPrepared(null);
  }, [commitBusy]);

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '28px clamp(14px,3.5vw,32px) 80px' }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>Rules</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>Manage executable rules and review their governed history.</p>
        </div>
        <Select
          label="Rule lifecycle"
          value={filter}
          onValueChange={(next) => { if (next !== null) setFilter(next as RuleLifecycleFilter); }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'enabled', label: 'Enabled' },
            { value: 'disabled', label: 'Disabled' },
            { value: 'retired', label: 'Retired' },
          ]}
        />
      </header>

      {activeCompanyId && <ClassificationMemoryPanel companyId={activeCompanyId} title="Search classification knowledge" />}

      {sourceCase && (
        <section id={`classification-case-${sourceCase.id}`} aria-label="Source classification case" style={{ border: '1px solid var(--bd)', borderRadius: 10, padding: 16, marginBottom: 18 }}>
          <h2 style={{ fontSize: 17, margin: 0 }}>Source classification case</h2>
          <p>{sourceCase.rationale}</p>
          <div style={{ color: 'var(--mut)', fontSize: 13 }}>
            Verified {fmtDate(sourceCase.verifiedAt)} · {sourceCase.context.sourceAccountName ?? 'Unknown source account'} · {readable(sourceCase.originIntent)}
          </div>
          {sourceCase.citations.slice(0, 10).map((citation) => (
            <a key={citation.url} href={citation.url} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: 6 }}>{citation.title} — {citation.publisher}</a>
          ))}
        </section>
      )}

      <section aria-labelledby="lifecycle-rules-title">
        <h2 id="lifecycle-rules-title" style={{ fontSize: 19 }}>Executable Rules</h2>
        {rulesError && <div role="alert" aria-label="Rules unavailable" style={{ color: 'var(--erT)', marginBottom: 10 }}>
          {rulesError}{' '}<button style={buttonStyle} disabled={rulesBusy} onClick={() => activeCompanyId && void loadFirstPage(activeCompanyId, filter)}>Retry rules</button>
        </div>}
        {reorderError && <div role="alert" aria-label="Rule ordering unavailable" style={{ color: 'var(--erT)', marginBottom: 10 }}>
          {reorderError}{' '}<button style={buttonStyle} disabled={reorderBusy} onClick={() => activeCompanyId && void loadReorderRules(activeCompanyId)}>Retry ordering</button>
        </div>}
        {rulesBusy && ruleList.length === 0 && <div role="status">Loading rules…</div>}
        {!rulesBusy && !rulesError && ruleList.length === 0 && (
          <section className="card" role="status" aria-label="No executable rules" style={{ padding: 18, marginTop: 12 }}>
            <strong>No executable rules match this lifecycle.</strong>
            <p style={{ color: 'var(--mut)', marginBottom: 12 }}>Rules are optional. Continue categorizing transactions manually, then create a governed rule from a reviewed Queue decision when a pattern is stable.</p>
            <Link to="/" className="btn-ghost">Create rule from Queue</Link>
          </section>
        )}
        {ruleGroups.map((group) => group.items.length > 0 && (
          <div
            key={group.key}
            role={group.linked ? 'region' : undefined}
            aria-labelledby={group.linked ? 'linked-source-rule-title' : undefined}
            style={group.linked ? { marginBottom: 16 } : undefined}
          >
            {group.linked && <>
              <h3 id="linked-source-rule-title" style={{ fontSize: 16, margin: '0 0 4px' }}>Linked source rule</h3>
              <p style={{ color: 'var(--mut)', fontSize: 13, margin: '0 0 9px' }}>Shown from the deep link; it is not part of the currently loaded lifecycle collection.</p>
            </>}
            <div style={{ display: 'grid', gap: 12 }}>
          {group.items.map((rule) => {
            const revision = rule.revision;
            const state = revision.state;
            const currentHistory = history[revision.ruleId];
            const currentTest = testResult[revision.ruleId];
            const enabledIndex = reorderRules.findIndex((row) => row.revision.ruleId === revision.ruleId);
            return (
              <article key={revision.ruleId} id={`rule-${revision.ruleId}`} style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 15 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div><strong>{revision.condition.matchText}</strong><div style={{ color: 'var(--mut)', fontSize: 12.5, marginTop: 3 }}>Priority {revision.priority} · revision {revision.revision}{revision.originIntent ? ` · ${readable(revision.originIntent)}` : ' · legacy provenance'}</div></div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className={state === 'enabled' ? 'pill-ok' : 'pill-am'}>{state[0]!.toUpperCase() + state.slice(1)}</span>
                    <span className={rule.executable ? 'pill-ok' : 'pill-am'}>{rule.executable ? 'Executable' : 'Advisory'}</span>
                  </div>
                </div>

                {revision.action ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px,1fr) minmax(180px,1fr)', gap: 10, marginTop: 12 }}>
                    <div>
                      <Combobox
                        label={`Category for ${revision.condition.matchText}`}
                        value={revision.action.categoryQboId}
                        disabled={state !== 'enabled'}
                        options={[
                          ...(!categoryOptions.some((option) => option.qboId === revision.action!.categoryQboId)
                            ? [{ value: revision.action.categoryQboId, label: revision.categoryName, disabled: true }]
                            : []),
                          ...categoryOptions.map((option) => ({ value: option.qboId, label: option.label, searchText: option.label })),
                        ]}
                        onValueChange={(next) => {
                          if (next !== null) startRuleOperation(rule, 'update', { categoryQboId: next });
                        }}
                        searchPlaceholder="Search categories…"
                        emptyText="No matching categories"
                      />
                    </div>
                    <div style={{ fontSize: 13.5 }}>
                      <div>{revision.categoryName}</div>
                      <div style={{ color: 'var(--mut)', marginTop: 4 }}>{readable(revision.action.taxCalculation)}{revision.taxCodeName ? ` · ${revision.taxCodeName}` : ''} · Auto-post {revision.autoPost ? 'on' : 'off'}</div>
                      {revision.action.tagIds.length > 0 && <div style={{ color: 'var(--mut)', marginTop: 4 }}>Tags: {revision.action.tagIds.map((id) => tagById.get(id) ?? 'Unavailable tag').join(', ')}</div>}
                    </div>
                  </div>
                ) : <p style={{ color: 'var(--mut)' }}>Stored for provenance only; no executable action is available.</p>}

                {(rule.reviewRequiredAt || rule.reviewReason) && <div role="alert" style={{ color: 'var(--amT)', marginTop: 10 }}>Review required{rule.reviewReason ? `: ${rule.reviewReason}` : ''}</div>}
                {revision.invalidReasons.slice(0, 10).map((reason) => <div key={reason} role="alert" style={{ color: 'var(--erT)', marginTop: 8 }}>{reason}</div>)}

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 13 }}>
                  {state !== 'retired' && <button style={buttonStyle} onClick={() => void testRule(rule)} disabled={testBusy !== null}>{testBusy === revision.ruleId ? 'Testing…' : 'Test rule'}</button>}
                  {state === 'enabled' && <>
                    <button style={buttonStyle} aria-label={`Move ${revision.condition.matchText} up`} disabled={!reorderReady || prepareBusy || prepared !== null || enabledIndex <= 0} onClick={() => reorderRule(rule, -1)}>Move up</button>
                    <button style={buttonStyle} aria-label={`Move ${revision.condition.matchText} down`} disabled={!reorderReady || prepareBusy || prepared !== null || enabledIndex < 0 || enabledIndex >= reorderRules.length - 1} onClick={() => reorderRule(rule, 1)}>Move down</button>
                    <button style={buttonStyle} aria-label={`Disable ${revision.condition.matchText}`} disabled={prepareBusy || prepared !== null} onClick={() => startRuleOperation(rule, 'disable')}>Disable</button>
                    <button style={buttonStyle} aria-label={`Retire ${revision.condition.matchText}`} disabled={prepareBusy || prepared !== null} onClick={() => startRuleOperation(rule, 'retire')}>Retire</button>
                    <button style={buttonStyle} aria-label={`${revision.autoPost ? 'Disable' : 'Enable'} auto-post for ${revision.condition.matchText}`} disabled={prepareBusy || prepared !== null} onClick={() => startRuleOperation(rule, 'update', { autoPost: !revision.autoPost })}>{revision.autoPost ? 'Disable auto-post' : 'Enable auto-post'}</button>
                  </>}
                  {state === 'disabled' && <>
                    <button style={buttonStyle} aria-label={`Enable ${revision.condition.matchText}`} disabled={prepareBusy || prepared !== null} onClick={() => startRuleOperation(rule, 'enable')}>Enable</button>
                    <button style={buttonStyle} aria-label={`Retire ${revision.condition.matchText}`} disabled={prepareBusy || prepared !== null} onClick={() => startRuleOperation(rule, 'retire')}>Retire</button>
                  </>}
                  <button style={buttonStyle} aria-label={`View history for ${revision.condition.matchText}`} onClick={() => void viewHistory(revision.ruleId)}>View history</button>
                </div>

                {currentTest && <div role="status" style={{ marginTop: 10, fontSize: 13 }}>
                  <div>{currentTest.pendingCount} pending · {currentTest.postedCount} posted · {currentTest.conflicts.length} conflicts</div>
                  {currentTest.conflicts.slice(0, 20).map((conflict) => (
                    <div key={conflict.ruleId} style={{ color: 'var(--amT)', marginTop: 4 }}>
                      Conflict: {conflict.matchText} → {conflict.category} · priority {conflict.priority}
                    </div>
                  ))}
                  {currentTest.matches.slice(0, 20).map((match) => (
                    <div key={match.txnId} style={{ color: 'var(--mut)', marginTop: 4 }}>
                      {match.payee} · {fmtDate(match.date)} · {fmtMoney(match.amount)} · {match.status.toLowerCase()}
                      {match.wouldWin ? ' · would win' : ` · existing winner: ${match.currentWinner ?? 'unknown'}`}
                    </div>
                  ))}
                </div>}
                {currentHistory && <div style={{ marginTop: 11, borderTop: '1px solid var(--bd2)', paddingTop: 9 }}>
                  {currentHistory.items.map((item, index, items) => (
                    <article key={item.id} aria-label={`Revision ${item.revision}`} style={{ fontSize: 13, marginTop: 9, paddingTop: 7, borderTop: index === 0 ? 'none' : '1px solid var(--bd2)' }}>
                      <strong>{`Revision ${item.revision} · ${item.state} · ${fmtDate(item.createdAt)}`}</strong>
                      {item.action ? (
                        <div style={{ marginTop: 4 }}>
                          {item.categoryName} ({item.action.categoryQboId}) · {readable(item.action.taxCalculation)} · {item.taxCodeName ?? 'No tax code'} ({item.action.taxCodeQboId ?? 'no QBO tax code'}) · Tags {item.action.tagIds.length > 0 ? item.action.tagIds.map((id) => `${tagById.get(id) ?? 'Unavailable tag'} (${id})`).join(', ') : 'none'} · priority {item.priority} · auto-post {onOff(item.autoPost)}
                        </div>
                      ) : <div style={{ marginTop: 4 }}>Legacy action unavailable — advisory provenance only.</div>}
                      <div style={{ marginTop: 4, color: 'var(--mut)' }}>
                        Provenance: {item.originIntent ? readable(item.originIntent) : 'legacy provenance'}
                        {item.sourceCaseId ? ` · source case ${item.sourceCaseId}` : ''}
                        {item.sourceCandidateId ? ` · source candidate ${item.sourceCandidateId}` : ''}
                        {item.changedBy ? ` · actor ${item.changedBy}` : ''}
                      </div>
                      <div style={{ marginTop: 4 }}>{item.valid ? 'Valid revision.' : `Invalid revision: ${item.invalidReasons.join(' · ') || 'No reason supplied.'}`}</div>
                      <div style={{ marginTop: 4 }}>{revisionChanges(
                        item,
                        items[index + 1],
                        currentHistory.olderExists && index === items.length - 1,
                      )}</div>
                    </article>
                  ))}
                  {currentHistory.olderExists && <div role="status" aria-label="Revision history truncated" style={{ color: 'var(--mut)', fontSize: 13, marginTop: 9 }}>
                    Showing {currentHistory.items.length} newest revision{currentHistory.items.length === 1 ? '' : 's'}; older history exists.
                  </div>}
                </div>}
              </article>
            );
          })}
            </div>
          </div>
        ))}
        {rulesTruncated && <div role="status" aria-label="Rule lifecycle truncated" style={{ color: 'var(--mut)', fontSize: 13, marginTop: 10 }}>
          Showing first {ruleList.length} rules in this lifecycle; more rules exist.
        </div>}
        {ruleCursor && <button style={{ ...buttonStyle, marginTop: 12 }} disabled={rulesBusy} onClick={() => void loadMoreRules()}>{rulesBusy ? 'Loading…' : 'Load more rules'}</button>}
      </section>

      <section aria-labelledby="candidate-title" style={{ marginTop: 28 }}>
        <h2 id="candidate-title" style={{ fontSize: 19 }}>Learned rule candidates</h2>
        <p style={{ color: 'var(--mut)', marginTop: 0 }}>These suggestions come from verified outcomes. Activation is explicit and never posts automatically; auto-post remains off.</p>
        {candidatesError && <div role="alert" aria-label="Candidates unavailable" style={{ color: 'var(--erT)', marginBottom: 10 }}>
          {candidatesError}{' '}<button style={buttonStyle} disabled={candidateBusy} onClick={() => activeCompanyId && void loadCandidates(activeCompanyId)}>Retry candidates</button>
        </div>}
        {candidateBusy && candidateList.length === 0 && !candidatesError && <div role="status">Loading candidates…</div>}
        {candidateGroups.map((group) => group.items.length > 0 && (
          <div
            key={group.key}
            role={group.linked ? 'region' : undefined}
            aria-labelledby={group.linked ? 'linked-source-candidate-title' : undefined}
            style={group.linked ? { marginBottom: 14 } : undefined}
          >
            {group.linked && <>
              <h3 id="linked-source-candidate-title" style={{ fontSize: 16, margin: '0 0 4px' }}>Linked source candidate</h3>
              <p style={{ color: 'var(--mut)', fontSize: 13, margin: '0 0 9px' }}>Shown from the deep link; it is not part of the currently loaded candidate collection.</p>
            </>}
            <div style={{ display: 'grid', gap: 10 }}>
          {group.items.map((candidate) => {
            const actionable = candidate.state !== 'activated' && candidate.state !== 'dismissed';
            return <article key={candidate.id} id={`rule-candidate-${candidate.id}`} style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 15 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}><strong>{candidate.matchText}</strong><span className={candidate.canActivate ? 'pill-ok' : 'pill-am'}>{readable(candidate.state)}</span></div>
            <div style={{ marginTop: 7 }}>{candidate.category ?? 'Unavailable category'} · {readable(candidate.taxCalculation ?? 'tax unavailable')}{candidate.taxCode ? ` · ${candidate.taxCode}` : ''}</div>
            <div style={{ color: 'var(--mut)', fontSize: 12.5, marginTop: 6 }}>{candidate.evidenceCount} verified outcomes · {candidate.provenance.user} reviewed by a person · {candidate.provenance.autopilot} by autopilot · {candidate.provenance.mcp} by MCP</div>
            {candidate.tagIds.length > 0 && <div style={{ color: 'var(--mut)', fontSize: 12.5, marginTop: 4 }}>Tags: {candidate.tagIds.map((id) => tagById.get(id) ?? 'Unavailable tag').join(', ')}</div>}
            {candidate.conflictingEvidenceCount > 0 && <div role="alert" style={{ color: 'var(--amT)', marginTop: 7 }}>{candidate.conflictingEvidenceCount} conflicting outcome{candidate.conflictingEvidenceCount === 1 ? '' : 's'}</div>}
            {candidate.staleReasons.slice(0, 10).map((reason) => <div key={reason} role="alert" style={{ color: 'var(--erT)', marginTop: 6 }}>{reason}</div>)}
            {actionable && <div style={{ display: 'flex', gap: 7, marginTop: 11 }}>
              {candidate.canActivate && <button style={buttonStyle} disabled={prepared !== null || prepareBusy} onClick={() => startCandidateOperation(candidate, 'activate_candidate')}>Activate rule</button>}
              <button style={buttonStyle} disabled={prepared !== null || prepareBusy} onClick={() => startCandidateOperation(candidate, 'dismiss_candidate')}>Dismiss</button>
            </div>}
          </article>;
          })}
            </div>
          </div>
        ))}
        {candidatesTruncated && <div role="status" aria-label="Rule candidates truncated" style={{ color: 'var(--mut)', fontSize: 13, marginTop: 10 }}>
          Showing newest {candidateList.length} candidates; older candidates exist.
        </div>}
        {candidateCursor && <button style={{ ...buttonStyle, marginTop: 12 }} disabled={candidateBusy} onClick={() => activeCompanyId && void loadCandidates(activeCompanyId, candidateCursor, true)}>{candidateBusy ? 'Loading…' : 'Load more candidates'}</button>}
      </section>

      {prepareError && <div role="alert" aria-label="Rule preparation unavailable" style={{ color: 'var(--erT)', marginTop: 16 }}>
        {prepareError}{' '}
        {pendingPreparationRef.current && <button style={buttonStyle} disabled={prepareBusy} onClick={() => pendingPreparationRef.current && void runPreparation(pendingPreparationRef.current)}>Retry preparation</button>}
        <button style={{ ...buttonStyle, marginLeft: 6 }} disabled={prepareBusy} onClick={cancelPreparation}>Cancel preparation</button>
      </div>}

      <ConfirmDialog
        open={prepared?.result.preview != null}
        title="Review rule change"
        confirmLabel={prepared?.confirmLabel ?? 'Confirm'}
        tone={prepared?.result.mutation === 'retire' || prepared?.result.mutation === 'dismiss_candidate' ? 'danger' : 'primary'}
        busy={commitBusy}
        onConfirm={() => void commitOperation()}
        onCancel={cancelPreparation}
      >
        {prepared && <PreviewBody operation={prepared} />}
      </ConfirmDialog>
    </main>
  );
}
