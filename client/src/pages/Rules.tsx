// Rules screen — payee-match rules that pre-fill category + tags in the queue.
// Layout/styles copied verbatim from design_handoff_recat/Recat.dc.html lines
// 502–546; interaction logic mirrors renderVals() lines 1583–1604.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import type { RuleCandidateDto, RuleDto, RuleTestResult } from '@recat/shared';
import { isUsableTaxCodeDto } from '@recat/shared';
import { ruleCandidates as ruleCandidatesApi, rules as rulesApi } from '../lib/api';
import type { RuleBody } from '../lib/api';
import { fmtDate, fmtMoney } from '../lib/format';
import { useApp } from '../state/AppContext';
import { InfoDot } from '../components/ui';

const RULES_TIP =
  'Rules run on every sync. A match shows as a suggestion — nothing posts without you unless you turn on auto-post for that rule (auto-post still respects dry-run). Recat also offers to create a rule right after you categorize a new payee. When several rules match, the topmost one wins — drag to reorder.';

// Grid columns per prototype: rows `minmax(150px,1fr) 240px minmax(180px,1fr) 80px 36px`,
// add-row `minmax(150px,1fr) 240px 1fr 130px`; both collapse to 1fr ≤640px
// (rulesGridCols / rulesAddCols). Hover/focus states need CSS, hence the <style>.
// Deliberate extensions over the prototype: an 18px drag-handle column leads
// the head/row grids for priority reordering (hidden ≤640px — reordering is
// desktop-only for now), and the add-row gains an `auto` column for the Test
// button (`minmax(150px,1fr) 240px 1fr auto 130px`).
const RULES_CSS = `
.rr .rules-head{display:grid;grid-template-columns:18px minmax(150px,1fr) 240px minmax(180px,1fr) 80px 36px;gap:0 16px;padding:10px 20px;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--fnt);border-bottom:1px solid var(--bd2);}
.rr .rules-row{display:grid;grid-template-columns:18px minmax(150px,1fr) 240px minmax(180px,1fr) 80px 36px;gap:8px 16px;align-items:center;padding:11px 20px;border-bottom:1px solid var(--rowbd);}
.rr .rules-add{display:grid;grid-template-columns:minmax(150px,1fr) 240px 1fr auto 130px;gap:8px 16px;align-items:center;padding:14px 20px;background:var(--hl);border-radius:0 0 10px 10px;}
.rr .rules-inline-input{font-size:14px;font-weight:500;border:1px solid transparent;border-radius:6px;padding:5px 8px;margin-left:-9px;background:transparent;color:var(--ink);outline:none;font-family:inherit;width:100%;box-sizing:border-box;}
.rr .rules-inline-input:hover{border-color:var(--bd);}
.rr .rules-inline-input:focus{border-color:var(--acc);background:var(--card);}
.rr .rules-add-input{font-size:14px;border:1px solid var(--bd);border-radius:7px;padding:8px 12px;background:var(--card);color:var(--ink);outline:none;font-family:inherit;width:100%;box-sizing:border-box;}
.rr .rules-add-input:focus{border-color:var(--acc);}
.rr .rules-add-btn{background:var(--acc);color:#fff;border:none;border-radius:7px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;font:inherit;justify-self:end;}
.rr .rules-add-btn:hover{background:var(--accH);}
.rr .rules-tagopt:hover{background:var(--hl);}
.rr .rules-del:hover{color:var(--erT);}
.rr .rules-drag{font-size:16px;color:var(--fnt);cursor:grab;user-select:none;line-height:1;}
.rr .rules-actions{display:contents;}
.rr .rules-auto-label{display:none;}
.rr .rules-add-actions{display:contents;}
@media (max-width:640px){
.rr .rules-head{display:none;}
.rr .rules-row,.rr .rules-add{grid-template-columns:1fr;}
.rr .rules-drag{display:none;}
.rr .rules-actions{display:flex;align-items:center;}
.rr .rules-auto{display:flex;align-items:center;gap:8px;text-align:left;}
.rr .rules-auto-label{display:inline;font-size:13px;color:var(--mut);font-weight:500;}
.rr .rules-actions .rules-del{margin-left:auto;}
.rr .rules-add-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;}
}
`;

// Row category select — prototype line 518.
const rowSelectStyle: CSSProperties = {
  border: '1px solid var(--bd)',
  borderRadius: 7,
  padding: '7px 10px',
  fontSize: 13.5,
  background: 'var(--card)',
  color: 'var(--ink)',
  cursor: 'pointer',
  width: '100%',
};

// Add-row category select — prototype line 537 (padding 8px 10px).
const addSelectStyle: CSSProperties = {
  border: '1px solid var(--bd)',
  borderRadius: 7,
  padding: '8px 10px',
  fontSize: 13.5,
  background: 'var(--card)',
  color: 'var(--ink)',
  cursor: 'pointer',
  width: '100%',
};

// Delete × — prototype line 532.
const delStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'var(--fnt)',
  fontSize: 16,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const MATCH_DEBOUNCE_MS = 500;

export default function Rules() {
  const { activeCompanyId, accounts, tags, taxReadiness, toast } = useApp();

  const [ruleList, setRuleList] = useState<RuleDto[]>([]);
  const [candidateList, setCandidateList] = useState<RuleCandidateDto[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [candidateLoadingMore, setCandidateLoadingMore] = useState(false);
  const [candidateBusy, setCandidateBusy] = useState<string | null>(null);
  const activeCompanyIdRef = useRef(activeCompanyId);
  const candidatePageRequest = useRef(0);
  const candidateActionRequest = useRef(0);
  activeCompanyIdRef.current = activeCompanyId;
  // Bumped per rule when a matchText PATCH fails, so the (uncontrolled) input
  // re-mounts and shows the server's value again.
  const [matchResets, setMatchResets] = useState<Record<string, number>>({});
  const [openTagMenu, setOpenTagMenu] = useState<string | null>(null);
  const [newMatch, setNewMatch] = useState('');
  const [newCat, setNewCat] = useState('');
  // Draft-rule test results ({text} is the tested matchText). Dismissed via the
  // panel's × or automatically on a successful Add rule.
  const [testRes, setTestRes] = useState<{ text: string; result: RuleTestResult } | null>(null);

  // Debounced payee-match edits: pending value + timer per rule id.
  const matchTimers = useRef(new Map<string, number>());
  const pendingMatch = useRef(new Map<string, string>());

  // Drag-to-reorder (match priority — topmost rule wins). Same HTML5 pattern as
  // the Dashboard widgets, but only the handle cell is draggable since rows
  // contain inputs. dragRef mirrors state for rapid-fire dragover handlers;
  // orderBeforeDrag is the rollback snapshot if the PUT fails.
  const [dragId, setDragId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const orderBeforeDrag = useRef<RuleDto[] | null>(null);

  // Category options: 'Group · Name' from Income/COGS/Expenses accounts
  // (prototype catOpts — value is the account name, label prefixed with group).
  const catOpts = useMemo(
    () =>
      accounts
        .filter(
          (a) =>
            (a.classification === 'Income' || a.classification === 'COGS' || a.classification === 'Expenses') &&
            !/^uncategorized |^ask my accountant$/i.test(a.name),
        )
        .map((a) => ({ v: a.name, label: `${a.classification} · ${a.name}`, qboId: a.qboId })),
    [accounts],
  );

  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  // ---- load rules (server returns match order: priority asc — render as-is) ----
  useEffect(() => {
    const companyId = activeCompanyId;
    const candidateRequestId = ++candidatePageRequest.current;
    candidateActionRequest.current += 1;
    setRuleList([]);
    setCandidateList([]);
    setCandidateCursor(null);
    setCandidateLoadingMore(false);
    setCandidateBusy(null);
    setTestRes(null);
    if (!companyId) return;
    let cancelled = false;
    rulesApi
      .list(companyId)
      .then((list) => {
        if (cancelled) return;
        setRuleList(list);
      })
      .catch((err: Error) => {
        if (!cancelled) toast(err.message);
      });
    ruleCandidatesApi
      .list(companyId)
      .then((page) => {
        if (
          !cancelled &&
          candidatePageRequest.current === candidateRequestId &&
          activeCompanyIdRef.current === companyId
        ) {
          setCandidateList(page.candidates);
          setCandidateCursor(page.nextCursor);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) toast(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, toast]);

  const loadMoreCandidates = useCallback(() => {
    if (!activeCompanyId || !candidateCursor || candidateLoadingMore) return;
    const companyId = activeCompanyId;
    const requestId = ++candidatePageRequest.current;
    setCandidateLoadingMore(true);
    ruleCandidatesApi
      .list(companyId, candidateCursor)
      .then((page) => {
        if (
          candidatePageRequest.current !== requestId ||
          activeCompanyIdRef.current !== companyId
        ) return;
        setCandidateList((current) => {
          const existing = new Set(current.map((candidate) => candidate.id));
          return [
            ...current,
            ...page.candidates.filter((candidate) => !existing.has(candidate.id)),
          ];
        });
        setCandidateCursor(page.nextCursor);
      })
      .catch((err: Error) => {
        if (
          candidatePageRequest.current === requestId &&
          activeCompanyIdRef.current === companyId
        ) toast(err.message);
      })
      .finally(() => {
        if (
          candidatePageRequest.current === requestId &&
          activeCompanyIdRef.current === companyId
        ) setCandidateLoadingMore(false);
      });
  }, [activeCompanyId, candidateCursor, candidateLoadingMore, toast]);

  const activateCandidate = useCallback(
    (candidate: RuleCandidateDto) => {
      if (!activeCompanyId || candidateBusy !== null) return;
      const companyId = activeCompanyId;
      const requestId = ++candidateActionRequest.current;
      const requestIsCurrent = () =>
        candidateActionRequest.current === requestId &&
        activeCompanyIdRef.current === companyId;
      setCandidateBusy(candidate.id);
      ruleCandidatesApi
        .activate(companyId, candidate.id)
        .then(() => {
          if (!requestIsCurrent()) return null;
          setCandidateList((current) => current.filter((row) => row.id !== candidate.id));
          return rulesApi.list(companyId);
        })
        .then((list) => {
          if (!list || !requestIsCurrent()) return;
          setRuleList(list);
          toast('Rule activated — auto-post remains off');
        })
        .catch((err: Error) => {
          if (requestIsCurrent()) toast(err.message);
        })
        .finally(() => {
          if (requestIsCurrent()) setCandidateBusy(null);
        });
    },
    [activeCompanyId, candidateBusy, toast],
  );

  const dismissCandidate = useCallback(
    (candidate: RuleCandidateDto) => {
      if (!activeCompanyId || candidateBusy !== null) return;
      const companyId = activeCompanyId;
      const requestId = ++candidateActionRequest.current;
      const requestIsCurrent = () =>
        candidateActionRequest.current === requestId &&
        activeCompanyIdRef.current === companyId;
      setCandidateBusy(candidate.id);
      ruleCandidatesApi
        .dismiss(companyId, candidate.id)
        .then(() => {
          if (!requestIsCurrent()) return;
          setCandidateList((current) => current.filter((row) => row.id !== candidate.id));
          toast('Rule candidate dismissed');
        })
        .catch((err: Error) => {
          if (requestIsCurrent()) toast(err.message);
        })
        .finally(() => {
          if (requestIsCurrent()) setCandidateBusy(null);
        });
    },
    [activeCompanyId, candidateBusy, toast],
  );

  // Close the tags dropdown on any outside click (prototype closes menus on root click).
  useEffect(() => {
    if (openTagMenu === null) return;
    const close = () => setOpenTagMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openTagMenu]);

  // Clear pending debounce timers on unmount.
  useEffect(() => {
    const timers = matchTimers.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
    };
  }, []);

  // `revert` undoes the caller's optimistic update when the PATCH fails.
  const patchRule = useCallback(
    (ruleId: string, body: Partial<RuleBody>, revert?: () => void) => {
      if (!activeCompanyId) return;
      rulesApi
        .patch(activeCompanyId, ruleId, body)
        .then((updated) => setRuleList((prev) => prev.map((r) => (r.id === ruleId ? updated : r))))
        .catch((err: Error) => {
          revert?.();
          toast(err.message);
        });
    },
    [activeCompanyId, toast],
  );

  const commitMatch = useCallback(
    (rule: RuleDto) => {
      const timer = matchTimers.current.get(rule.id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        matchTimers.current.delete(rule.id);
      }
      const value = pendingMatch.current.get(rule.id);
      pendingMatch.current.delete(rule.id);
      if (value === undefined || value === rule.matchText) return;
      patchRule(rule.id, { matchText: value }, () =>
        setMatchResets((prev) => ({ ...prev, [rule.id]: (prev[rule.id] ?? 0) + 1 })),
      );
    },
    [patchRule],
  );

  const onMatchChange = useCallback(
    (rule: RuleDto, value: string) => {
      pendingMatch.current.set(rule.id, value);
      const existing = matchTimers.current.get(rule.id);
      if (existing !== undefined) window.clearTimeout(existing);
      matchTimers.current.set(
        rule.id,
        window.setTimeout(() => commitMatch(rule), MATCH_DEBOUNCE_MS),
      );
    },
    [commitMatch],
  );

  const setRuleCat = useCallback(
    (rule: RuleDto, catName: string) => {
      const opt = catOpts.find((c) => c.v === catName);
      setRuleList((prev) => prev.map((r) => (r.id === rule.id ? { ...r, category: catName } : r)));
      patchRule(rule.id, { category: catName, categoryQboId: opt ? opt.qboId : null }, () =>
        setRuleList((prev) => prev.map((r) => (r.id === rule.id ? { ...r, category: rule.category } : r))),
      );
    },
    [catOpts, patchRule],
  );

  const toggleRuleTag = useCallback(
    (rule: RuleDto, tagId: string) => {
      const next = rule.tagIds.includes(tagId)
        ? rule.tagIds.filter((i) => i !== tagId)
        : [...rule.tagIds, tagId];
      setRuleList((prev) => prev.map((r) => (r.id === rule.id ? { ...r, tagIds: next } : r)));
      patchRule(rule.id, { tagIds: next }, () =>
        setRuleList((prev) => prev.map((r) => (r.id === rule.id ? { ...r, tagIds: rule.tagIds } : r))),
      );
    },
    [patchRule],
  );

  const toggleAuto = useCallback(
    (rule: RuleDto) => {
      setRuleList((prev) => prev.map((r) => (r.id === rule.id ? { ...r, autoPost: !r.autoPost } : r)));
      patchRule(rule.id, { autoPost: !rule.autoPost }, () =>
        setRuleList((prev) => prev.map((r) => (r.id === rule.id ? { ...r, autoPost: rule.autoPost } : r))),
      );
    },
    [patchRule],
  );

  const deleteRule = useCallback(
    (rule: RuleDto) => {
      if (!activeCompanyId) return;
      rulesApi
        .del(activeCompanyId, rule.id)
        .then(() => {
          setRuleList((prev) => prev.filter((r) => r.id !== rule.id));
          toast('Rule deleted');
        })
        .catch((err: Error) => toast(err.message));
    },
    [activeCompanyId, toast],
  );

  const setDrag = useCallback((id: string | null) => {
    dragRef.current = id;
    setDragId(id);
  }, []);

  const onRowDragStart = useCallback(
    (rule: RuleDto) => (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', '');
      } catch {
        // some browsers throw on setData — harmless
      }
      setRuleList((prev) => {
        orderBeforeDrag.current = prev;
        return prev;
      });
      setDrag(rule.id);
    },
    [setDrag],
  );

  // Indices are resolved from the CURRENT array at event time — the render-time
  // index can be stale after a mid-drag reorder.
  const onRowDragOver = useCallback(
    (rule: RuleDto) => (e: DragEvent) => {
      e.preventDefault();
      const d = dragRef.current;
      if (d === null || d === rule.id) return;
      setRuleList((prev) => {
        const from = prev.findIndex((r) => r.id === d);
        const to = prev.findIndex((r) => r.id === rule.id);
        if (from === -1 || to === -1 || from === to) return prev;
        const next = [...prev];
        const mv = next.splice(from, 1)[0];
        if (!mv) return prev;
        next.splice(to, 0, mv);
        return next;
      });
    },
    [],
  );

  const onRowDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
  }, []);

  // Persist on drag end (optimistic — the list already shows the new order);
  // roll back to the pre-drag snapshot if the PUT fails.
  const onRowDragEnd = useCallback(() => {
    setDrag(null);
    const before = orderBeforeDrag.current;
    orderBeforeDrag.current = null;
    if (!activeCompanyId) return;
    setRuleList((prev) => {
      if (before && before.map((r) => r.id).join() === prev.map((r) => r.id).join()) return prev; // no move
      rulesApi
        .reorder(
          activeCompanyId,
          prev.map((r) => r.id),
        )
        .then((list) => setRuleList(list))
        .catch((err: Error) => {
          if (before) setRuleList(before);
          toast(err.message);
        });
      return prev;
    });
  }, [activeCompanyId, setDrag, toast]);

  const addRule = useCallback(() => {
    if (!activeCompanyId) return;
    if (!newMatch.trim() || !newCat) {
      toast('Enter a payee match and pick a category');
      return;
    }
    const opt = catOpts.find((c) => c.v === newCat);
    const body: RuleBody = {
      matchText: newMatch.trim(),
      category: newCat,
      categoryQboId: opt ? opt.qboId : null,
      tagIds: [],
      autoPost: false,
    };
    rulesApi
      .create(activeCompanyId, body)
      .then((created) => {
        setRuleList((prev) => [created, ...prev]);
        setNewMatch('');
        setNewCat('');
        setTestRes(null);
        toast('Rule created');
      })
      .catch((err: Error) => toast(err.message));
  }, [activeCompanyId, newMatch, newCat, catOpts, toast]);

  // Dry-run the draft rule against recent transactions — nothing is saved.
  const testRule = useCallback(() => {
    if (!activeCompanyId) return;
    const text = newMatch.trim();
    if (!text) return;
    rulesApi
      .test(activeCompanyId, text)
      .then((result) => setTestRes({ text, result }))
      .catch((err: Error) => toast(err.message));
  }, [activeCompanyId, newMatch, toast]);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '28px clamp(14px,3.5vw,32px) 80px' }}>
      <style>{RULES_CSS}</style>
      <div style={{ marginBottom: 18 }}>
        <div className="page-title">Rules</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 14,
            color: 'var(--fnt)',
            marginTop: 4,
          }}
        >
          When a payee matches, Recat pre-fills the category and tags in the queue.
          <InfoDot tip={RULES_TIP} />
        </div>
      </div>
      {(candidateList.length > 0 || candidateCursor !== null) && (
        <section style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 650, marginBottom: 5 }}>
            Learned rule candidates
          </div>
          <div style={{ color: 'var(--mut)', fontSize: 13.5, marginBottom: 10 }}>
            Recat proposes these only after three current verified outcomes agree.
            Review is required; activating creates a normal rule and never posts automatically.
          </div>
          <div className="card">
            {candidateList.map((candidate) => {
              const people = candidate.provenance.user;
              const autopilot = candidate.provenance.autopilot;
              const mcp = candidate.provenance.mcp;
              const appliedTags = candidate.tagIds
                .map((id) => tagById.get(id)?.name)
                .filter((name): name is string => Boolean(name));
              const provenance = [
                `${people} reviewed by a person`,
                `${autopilot} by autopilot`,
                ...(mcp > 0 ? [`${mcp} through MCP`] : []),
              ].join(' · ');
              return (
                <div
                  key={candidate.id}
                  style={{
                    padding: '15px 18px',
                    borderBottom: '1px solid var(--rowbd)',
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 650 }}>{candidate.matchText}</div>
                      <div style={{ color: 'var(--mut)', fontSize: 13.5, marginTop: 3 }}>
                        {candidate.category ?? 'Unavailable category'}
                        {candidate.taxCode ? ` · ${candidate.taxCode}` : ''}
                        {appliedTags.length > 0 ? ` · ${appliedTags.join(', ')}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button
                        className="btn-ghost"
                        onClick={() => dismissCandidate(candidate)}
                        disabled={candidateBusy !== null}
                      >
                        Dismiss
                      </button>
                      {candidate.canActivate && (
                        <button
                          className="rules-add-btn"
                          onClick={() => activateCandidate(candidate)}
                          disabled={candidateBusy !== null}
                        >
                          Activate rule
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ color: 'var(--fnt)', fontSize: 12.5 }}>
                    {candidate.evidenceCount} verified outcomes · {provenance}
                  </div>
                  {candidate.conflictingEvidenceCount > 0 && (
                    <div role="alert" style={{ color: 'var(--amT)', fontSize: 12.5 }}>
                      {candidate.conflictingEvidenceCount} conflicting outcome
                      {candidate.conflictingEvidenceCount === 1 ? '' : 's'} — activation is blocked.
                    </div>
                  )}
                  {candidate.staleReasons.map((reason) => (
                    <div key={reason} role="alert" style={{ color: 'var(--erT)', fontSize: 12.5 }}>
                      {reason}
                    </div>
                  ))}
                </div>
              );
            })}
            {candidateCursor && (
              <div style={{ padding: '12px 18px', textAlign: 'center' }}>
                <button
                  className="btn-ghost"
                  onClick={loadMoreCandidates}
                  disabled={candidateLoadingMore}
                  aria-label="Load more candidates"
                >
                  {candidateLoadingMore ? 'Loading…' : 'Load more candidates'}
                </button>
              </div>
            )}
          </div>
        </section>
      )}
      <div className="card">
        <div className="rules-head">
          <span></span>
          <span>Payee contains</span>
          <span>Category</span>
          <span>Apply tags</span>
          <span style={{ textAlign: 'center' }}>Auto-post</span>
          <span></span>
        </div>
        {ruleList.map((rule) => {
          const tagNames = rule.tagIds
            .map((id) => tagById.get(id)?.name)
            .filter((n): n is string => Boolean(n));
          const taxReferenceInvalid =
            rule.taxCodeQboId !== null &&
            (
              taxReadiness?.status !== 'ready' ||
              !taxReadiness.taxCodes.some(
                (code) =>
                  code.qboId === rule.taxCodeQboId &&
                  isUsableTaxCodeDto(code),
              )
            );
          return (
            <div
              key={rule.id}
              className="rules-row"
              onDragOver={onRowDragOver(rule)}
              onDrop={onRowDrop}
              style={{ opacity: dragId === rule.id ? 0.35 : 1 }}
            >
              <span
                className="rules-drag"
                draggable
                onDragStart={onRowDragStart(rule)}
                onDragEnd={onRowDragEnd}
                data-tip="Drag to reorder — topmost matching rule wins"
              >
                ⋮⋮
              </span>
              <input
                key={`${rule.id}:${matchResets[rule.id] ?? 0}`}
                defaultValue={rule.matchText}
                onChange={(e) => onMatchChange(rule, e.target.value)}
                onBlur={() => commitMatch(rule)}
                className="rules-inline-input"
              />
              <select
                value={rule.category}
                onChange={(e) => setRuleCat(rule, e.target.value)}
                style={rowSelectStyle}
              >
                {rule.category && !catOpts.some((c) => c.v === rule.category) && (
                  <option value={rule.category}>{rule.category}</option>
                )}
                {catOpts.map((c) => (
                  <option key={c.v} value={c.v}>
                    {c.label}
                  </option>
                ))}
              </select>
              <span style={{ position: 'relative', display: 'block' }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenTagMenu((cur) => (cur === rule.id ? null : rule.id));
                  }}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    textAlign: 'left',
                    border: '1px solid var(--bd)',
                    borderRadius: 7,
                    padding: '7px 10px',
                    fontSize: 13.5,
                    background: 'var(--card)',
                    color: tagNames.length ? 'var(--ink)' : 'var(--fnt)',
                    cursor: 'pointer',
                    font: 'inherit',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {tagNames.length ? tagNames.join(', ') : 'No tags'}{' '}
                  <span style={{ color: 'var(--fnt)', fontSize: 10 }}>▾</span>
                </button>
                {openTagMenu === rule.id && (
                  <span
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute',
                      zIndex: 18,
                      top: 'calc(100% + 6px)',
                      left: 0,
                      width: 'min(240px,86vw)',
                      maxHeight: 240,
                      overflow: 'auto',
                      background: 'var(--card)',
                      border: '1px solid var(--bd)',
                      borderRadius: 9,
                      boxShadow: 'var(--sh)',
                      display: 'block',
                    }}
                  >
                    {tags.map((tag) => (
                      <button
                        key={tag.id}
                        className="rules-tagopt"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRuleTag(rule, tag.id);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 9,
                          width: '100%',
                          border: 'none',
                          background: 'none',
                          cursor: 'pointer',
                          padding: '9px 13px',
                          font: 'inherit',
                          fontSize: 13.5,
                          color: 'var(--ink)',
                          textAlign: 'left',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={rule.tagIds.includes(tag.id)}
                          readOnly
                          style={{ width: 14, height: 14, accentColor: 'var(--acc)', pointerEvents: 'none' }}
                        />
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: tag.color,
                            display: 'inline-block',
                          }}
                        />
                        {tag.name}
                      </button>
                    ))}
                  </span>
                )}
              </span>
              <span className="rules-actions">
                <span
                  className="rules-auto"
                  style={{ textAlign: 'center' }}
                  data-tip="Post automatically on sync — still respects dry-run mode"
                >
                  <span className="rules-auto-label">Auto-post</span>
                  <input
                    type="checkbox"
                    checked={rule.autoPost}
                    onChange={() => toggleAuto(rule)}
                    style={{ width: 15, height: 15, accentColor: 'var(--acc)', cursor: 'pointer' }}
                  />
                </span>
                <button className="rules-del" onClick={() => deleteRule(rule)} data-tip="Delete rule" style={delStyle}>
                  ×
                </button>
              </span>
              {taxReferenceInvalid && (
                <span
                  role="alert"
                  style={{
                    gridColumn: '2 / -1',
                    color: 'var(--erT)',
                    fontSize: 12.5,
                  }}
                >
                  Tax reference unavailable: {rule.taxCode ?? rule.taxCodeQboId}. This rule will not
                  apply tax until the reference is valid again.
                </span>
              )}
              {rule.origin && (
                <span
                  style={{
                    gridColumn: '2 / -1',
                    color: 'var(--mut)',
                    fontSize: 12.5,
                  }}
                >
                  Learned from {rule.origin.evidenceCount} verified outcomes · auto-post started off
                </span>
              )}
              {rule.reviewRequiredAt && (
                <span
                  role="alert"
                  style={{
                    gridColumn: '2 / -1',
                    color: 'var(--amT)',
                    fontSize: 12.5,
                  }}
                >
                  Review required: {rule.reviewReason ?? 'verified outcomes changed'}
                </span>
              )}
            </div>
          );
        })}
        <div className="rules-add">
          <input
            value={newMatch}
            onChange={(e) => setNewMatch(e.target.value)}
            placeholder="Payee contains…"
            className="rules-add-input"
          />
          <select value={newCat} onChange={(e) => setNewCat(e.target.value)} style={addSelectStyle}>
            <option value="">Category…</option>
            {catOpts.map((c) => (
              <option key={c.v} value={c.v}>
                {c.label}
              </option>
            ))}
          </select>
          <span></span>
          <span className="rules-add-actions">
            <button
              className="btn-ghost"
              onClick={testRule}
              disabled={!newMatch.trim()}
              data-tip="Preview which transactions this rule would match — nothing is saved"
              style={{ opacity: newMatch.trim() ? 1 : 0.45, cursor: newMatch.trim() ? 'pointer' : 'default' }}
            >
              Test
            </button>
            <button className="rules-add-btn" onClick={addRule}>
              Add rule
            </button>
          </span>
        </div>
        {testRes && (
          <div
            style={{
              position: 'relative',
              padding: '12px 20px 16px',
              background: 'var(--hl)',
              borderTop: '1px solid var(--bd2)',
              borderRadius: '0 0 10px 10px',
              fontSize: 13.5,
            }}
          >
            <button
              onClick={() => setTestRes(null)}
              data-tip="Dismiss"
              style={{
                position: 'absolute',
                top: 8,
                right: 12,
                border: 'none',
                background: 'none',
                color: 'var(--fnt)',
                fontSize: 15,
                cursor: 'pointer',
                fontFamily: 'inherit',
                lineHeight: 1,
              }}
            >
              ×
            </button>
            {testRes.result.matches.length === 0 ? (
              <span style={{ color: 'var(--fnt)' }}>
                No pending or posted transactions match &ldquo;{testRes.text}&rdquo;.
              </span>
            ) : (
              <>
                <div style={{ fontWeight: 600 }}>
                  {testRes.result.matches.length} matching transaction
                  {testRes.result.matches.length === 1 ? '' : 's'} ({testRes.result.pendingCount}{' '}
                  pending · {testRes.result.postedCount} posted)
                </div>
                {testRes.result.matches.slice(0, 8).map((m) => (
                  <div key={m.txnId} style={{ color: 'var(--mut)', marginTop: 5 }}>
                    {fmtDate(m.date)} · {m.payee} · {fmtMoney(m.amount)}
                  </div>
                ))}
                {testRes.result.conflicts[0] && (
                  <div style={{ color: 'var(--amT)', marginTop: 8 }}>
                    ⚠ Also matched by: &ldquo;{testRes.result.conflicts[0].matchText}&rdquo; →{' '}
                    {testRes.result.conflicts[0].category}
                    {testRes.result.conflicts.length > 1
                      ? ` (and ${testRes.result.conflicts.length - 1} more)`
                      : ''}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
