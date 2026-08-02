import { useCallback, useEffect, useRef, useState } from 'react';
import type { McpTokenDto } from '@recat/shared';
import { mcpTokens } from '../../lib/api';

const DEFAULT_EXPIRY_DAYS = 90;

export default function McpTokensCard() {
  const [tokens, setTokens] = useState<McpTokenDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [oneTimeToken, setOneTimeToken] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const secretRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const listRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (mountedRef.current) setLoadingMore(false);
    const page = await mcpTokens.list({ limit: 20 });
    if (!mountedRef.current || requestId !== listRequestRef.current) return;
    setTokens(page.items);
    setNextCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load()
      .catch(() => {
        if (mountedRef.current) setError('Could not load MCP tokens.');
      });
    return () => {
      mountedRef.current = false;
      listRequestRef.current += 1;
      secretRef.current = null;
    };
  }, [load]);

  const create = async () => {
    const trimmed = label.trim();
    if (!trimmed || creating || secretRef.current !== null) return;
    setCreating(true);
    setError(null);
    setCopyStatus(null);
    try {
      const result = await mcpTokens.create({
        label: trimmed,
        expiresInDays: DEFAULT_EXPIRY_DAYS,
      });
      if (!mountedRef.current) return;
      listRequestRef.current += 1;
      setLoadingMore(false);
      secretRef.current = result.token;
      setOneTimeToken(result.token);
      setTokens((current) => [
        result.mcpToken,
        ...current.filter((token) => token.id !== result.mcpToken.id),
      ]);
      setLabel('');
    } catch {
      if (mountedRef.current) setError('Could not create MCP token.');
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  };

  const dismiss = () => {
    secretRef.current = null;
    setOneTimeToken(null);
    setCopyStatus(null);
    setError(null);
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await mcpTokens.revoke(id);
      if (!mountedRef.current) return;
      await load();
    } catch {
      if (mountedRef.current) setError('Could not revoke MCP token.');
    }
  };

  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    const requestId = ++listRequestRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await mcpTokens.list({ limit: 20, cursor: nextCursor });
      if (!mountedRef.current || requestId !== listRequestRef.current) return;
      setTokens((current) => {
        const seen = new Set(current.map((token) => token.id));
        return [...current, ...page.items.filter((token) => !seen.has(token.id))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      if (mountedRef.current && requestId === listRequestRef.current) {
        setError('Could not load more MCP tokens.');
      }
    } finally {
      if (mountedRef.current && requestId === listRequestRef.current) {
        setLoadingMore(false);
      }
    }
  };

  const copy = async () => {
    const token = secretRef.current;
    if (token === null) return;
    setError(null);
    setCopyStatus(null);
    try {
      await navigator.clipboard.writeText(token);
      if (mountedRef.current) setCopyStatus('Token copied.');
    } catch {
      if (mountedRef.current) setError('Could not copy the token. Copy it manually.');
    }
  };

  return (
    <section
      style={{
        border: '1px solid var(--bd2)',
        borderRadius: 10,
        background: 'var(--card)',
        padding: '20px 24px',
        boxShadow: '0 1px 6px rgba(60,55,45,.05)',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600 }}>MCP access tokens</div>
      <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
        Create an expiring token for an MCP client. New tokens expire after 90 days.
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <input
          aria-label="Token label"
          value={label}
          maxLength={80}
          disabled={oneTimeToken !== null}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Desktop agent"
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          disabled={creating || oneTimeToken !== null || label.trim() === ''}
          onClick={create}
        >
          {creating ? 'Creating…' : 'Create token'}
        </button>
      </div>

      {oneTimeToken !== null && (
        <div role="status" style={{ marginTop: 14, padding: 12, border: '1px solid var(--amD)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Copy this token now</div>
          <code style={{ display: 'block', overflowWrap: 'anywhere', margin: '8px 0' }}>
            {oneTimeToken}
          </code>
          <button
            type="button"
            aria-label="Copy token"
            onClick={copy}
          >
            Copy token
          </button>{' '}
          <button type="button" aria-label="Dismiss token" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      )}

      {copyStatus !== null && <div role="status">{copyStatus}</div>}
      {error !== null && <div role="alert">{error}</div>}

      <div style={{ marginTop: 14 }}>
        {tokens.map((token) => (
          <div
            key={token.id}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{token.label}</div>
              <div style={{ color: 'var(--mut)', fontSize: 12.5 }}>
                {token.prefix}… · {token.status} · expires{' '}
                {new Date(token.expiresAt).toLocaleDateString()}
              </div>
            </div>
            {token.status === 'active' && (
              <button
                type="button"
                aria-label={`Revoke ${token.label}`}
                onClick={() => revoke(token.id)}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
        {nextCursor !== null && (
          <button type="button" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </section>
  );
}
