// GM dock « Assistant »: chat with Claude about the campaign, the rules and the live game.
// Answers stream over the socket (assistant:delta / assistant:step / assistant:done); changes come back as
// proposal cards the GM applies with « Appliquer ». Server: server/modules/95-assistant.js.
import { useEffect, useRef, useState, useCallback, type KeyboardEvent } from 'react';
import { Button, IconButton, Markdown, Badge, Modal, Select, confirmAction } from '../../lib/ui.tsx';
import { api, useServerEvent, type GameProps, type ServerError } from '../../lib/net.ts';
import { toast, goTab, setUI } from '../../lib/ui-store.ts';
import { t, tk, fmtNumber, getLang } from '../../lib/i18n.ts';
import { renderThumbnail } from '../map/renderer.ts';
import type { GameMap, ServerEvents } from '../../../shared/types.ts';
import type { AskReply, AssistantStatus, Conversation, ConversationItem, ConversationSummary, Proposal, ProposalTemplate } from './types.ts';
import './assistant.css';

const LS_KEY = 'sr.assistant.conv';
const readLast = (): string | null => {
  try {
    return localStorage.getItem(LS_KEY) || null;
  } catch {
    return null;
  }
};
const writeLast = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LS_KEY, id);
    else localStorage.removeItem(LS_KEY);
  } catch {}
};

const usd = (n: unknown) => {
  const v = fmtNumber(Number(n) || 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return getLang() === 'en' ? `$${v}` : `${v} $`;
};

const KIND_LABEL: Record<string, string> = {
  map: tk('New map'),
  map_edits: tk('Map changes'),
  npc: tk('NPC (bestiary)'),
  handout: tk('Player handout (not revealed)'),
  quest: tk('Quest'),
  thread: tk('Plot thread'),
  session_plan: tk('Session plan'),
  gm_notes: tk('GM notes'),
};
const STATUS: Record<string, { color: string; label: string }> = {
  applied: { color: 'green', label: tk('Applied') },
  dismissed: { color: 'dim', label: tk('Dismissed') },
  failed: { color: 'red', label: tk('proposal::Failed') },
  partial: { color: 'amber', label: tk('Partly applied') },
};

function MapThumb({ map, size = 230, onClick }: { map: GameMap; size?: number; onClick?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && map) renderThumbnail(ref.current, map, size);
  }, [map, size]);
  return <canvas ref={ref} className="assistant-thumb" onClick={onClick} title={onClick ? t('Enlarge') : ''}></canvas>;
}

function NpcPreview({ tpl }: { tpl: ProposalTemplate }) {
  const a = tpl.attributes || {};
  const attrs = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'].map((k) => `${k} ${a[k] ?? '–'}`).join(' · ');
  return (
    <div className="assistant-npc small">
      <div className="muted">{[tpl.metatype, tpl.concept, tpl.npc?.professionalRating != null ? t('Professional rating {n}', { n: tpl.npc.professionalRating }) : ''].filter(Boolean).join(' — ')}</div>
      <div className="mono">{attrs}</div>
      {tpl.skills?.length ? <div>{tpl.skills.slice(0, 10).map((s) => `${s.name || s.id} ${s.rating}`).join(', ')}</div> : null}
      {tpl.weapons?.length ? <div>{tpl.weapons.map((w) => `${w.name} (${w.damage || '?'}${w.ap ? `, PA ${w.ap}` : ''})`).join(' · ')}</div> : null}
    </div>
  );
}

function ProposalCard({ p, onChanged }: { p: Proposal; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [big, setBig] = useState(false);
  const kindKey = (p.kind === 'campaign' ? p.sub : p.kind) || '';
  const status = STATUS[p.status];
  const apply = async () => {
    setBusy(true);
    try {
      await api(`/api/assistant/proposals/${p.id}/apply`, { method: 'POST' });
      toast(t('Proposal applied'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const dismiss = async () => {
    try {
      await api(`/api/assistant/proposals/${p.id}/dismiss`, { method: 'POST' });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    onChanged();
  };
  const open = () => {
    if (p.result?.mapId) {
      goTab('maps');
      setUI({ mapsEditId: p.result.mapId });
    } else if (p.kind === 'npc') goTab('bestiary');
    else goTab('campaign');
  };
  const map = p.preview?.map;
  return (
    <div className={`assistant-card ${p.status}`}>
      <div className="spread">
        <div>
          <span className="assistant-kind">{t(KIND_LABEL[kindKey] || kindKey)}</span> <strong>{p.title}</strong>
        </div>
        {status ? <Badge color={status.color}>{t(status.label)}</Badge> : null}
      </div>
      {map ? (
        <div className="assistant-mapprev">
          <MapThumb map={map} onClick={() => setBig(true)} />
          <div className="small muted">
            {t('{w} × {h} cells', { w: map.width, h: map.height })} · {tn2(map.regions?.length || 0)} · {t('{n} door(s)', { n: map.doors?.length || 0 })}
          </div>
        </div>
      ) : null}
      {p.preview?.template ? <NpcPreview tpl={p.preview.template} /> : null}
      {p.preview?.body ? (
        <details className="assistant-details">
          <summary>{t('Preview')}</summary>
          <Markdown text={p.preview.body} />
        </details>
      ) : null}
      {p.preview?.text ? (
        <details className="assistant-details">
          <summary>{t('Preview')}</summary>
          <Markdown text={p.preview.text} />
        </details>
      ) : null}
      {p.preview?.phases?.length ? (
        <ul className="small">
          {p.preview.phases.map((ph, i) => (
            <li key={i}>{ph}</li>
          ))}
        </ul>
      ) : null}
      {p.error ? <div className="small assistant-err">{p.error}</div> : null}
      <div className="row assistant-card-actions">
        {p.status === 'pending' ? (
          <>
            <Button variant="primary" small disabled={busy} onClick={apply}>
              {busy ? t('Applying…') : t('Apply')}
            </Button>
            <Button variant="ghost" small disabled={busy} onClick={dismiss}>
              {t('Dismiss')}
            </Button>
          </>
        ) : null}
        {p.status === 'applied' || p.status === 'partial' ? (
          <Button variant="ghost" small onClick={open}>
            {p.result?.mapId ? t('Open in Maps') : p.kind === 'npc' ? t('Open the bestiary') : t('Open the campaign')}
          </Button>
        ) : null}
        {p.status === 'failed' ? (
          <Button variant="ghost" small disabled={busy} onClick={apply}>
            {t('Retry')}
          </Button>
        ) : null}
      </div>
      {big && map ? (
        <Modal title={p.title} onClose={() => setBig(false)} width={760}>
          <div className="assistant-bigmap">
            <MapThumb map={map} size={700} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
const tn2 = (n: number) => t('{n} region(s)', { n });

function Item({ it, onChanged }: { it: ConversationItem; onChanged: () => void }) {
  switch (it.type) {
    case 'user':
      return (
        <div className="assistant-msg user">
          <div className="assistant-bubble">{it.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="assistant-msg bot">
          <Markdown text={it.text} className="assistant-md" />
        </div>
      );
    case 'tool':
      return <div className="assistant-tool">◇ {t(it.key, it.params)}</div>;
    case 'proposal':
      return <ProposalCard p={it.proposal} onChanged={onChanged} />;
    case 'notice':
      return <div className={`assistant-notice ${it.kind || 'info'}`}>{t(it.key, it.params || {})}</div>;
    default:
      return null;
  }
}

export default function AssistantDock({ game }: GameProps) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [convId, setConvId] = useState<string | null>(readLast());
  const [conv, setConv] = useState<Conversation | null>(null);
  const [live, setLive] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const convRef = useRef(convId);
  convRef.current = convId;

  const loadStatus = useCallback(async () => {
    try {
      const s = await api<AssistantStatus>('/api/assistant/status');
      setStatus(s);
      setBusy(!!s.busy);
      return s;
    } catch (err) {
      setStatus({ error: (err as Error).message });
      return null;
    }
  }, []);
  const loadConvs = useCallback(async () => {
    try {
      setConvs(await api<ConversationSummary[]>('/api/assistant/conversations'));
    } catch {}
  }, []);
  const loadConv = useCallback(async (id: string | null = convRef.current) => {
    if (!id) return setConv(null);
    try {
      setConv(await api<Conversation>(`/api/assistant/conversations/${id}`));
    } catch (err) {
      if ((err as ServerError).status === 404) {
        setConvId(null);
        writeLast(null);
        setConv(null);
      }
    }
  }, []);

  useEffect(() => {
    loadStatus().then((s) => {
      if (s?.enabled) {
        loadConvs();
        loadConv();
      }
    });
  }, []);
  useEffect(() => {
    writeLast(convId);
    if (status?.enabled) loadConv(convId);
  }, [convId]);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv, live]);

  useServerEvent('assistant:delta', (d: ServerEvents['assistant:delta']) => {
    if (d.conversationId === convRef.current) setLive((s) => s + d.text);
  });
  useServerEvent('assistant:step', (d: ServerEvents['assistant:step']) => {
    if (d.conversationId !== convRef.current) return;
    setBusy(true);
    setPhase(d.phase);
    if (d.phase === 'message' || d.phase === 'tools') {
      setLive('');
      loadConv(d.conversationId);
    }
  });
  useServerEvent('assistant:done', (d: ServerEvents['assistant:done']) => {
    setBusy(false);
    setPhase('');
    setLive('');
    loadStatus();
    loadConvs();
    if (d.conversationId === convRef.current) loadConv(d.conversationId);
  });

  if (!status) return <div className="assistant-empty muted">{t('Loading…')}</div>;
  if (status.error) return <div className="assistant-empty">{status.error}</div>;
  if (!status.enabled) {
    return (
      <div className="assistant-empty">
        <div className="assistant-title">{t('GM assistant')}</div>
        <p>{t('The assistant is not enabled for this table.')}</p>
        <p className="muted small">{game?.config?.table?.demo ? t('It is not available on the public demo table.') : t('The server admin can enable it in /admin → AI assistant.')}</p>
      </div>
    );
  }

  const ask = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setPhase('thinking');
    setLive('');
    try {
      const r = await api<AskReply>('/api/assistant/ask', { method: 'POST', body: { conversationId: convId, text: q, lang: getLang() } });
      setText('');
      if (r.conversationId !== convId) setConvId(r.conversationId);
      else loadConv(r.conversationId);
      loadConvs();
    } catch (err) {
      setBusy(false);
      setPhase('');
      toast((err as Error).message, 'error');
    }
  };
  const stopRun = () => api('/api/assistant/stop', { method: 'POST' }).catch(() => {});
  const newConv = () => {
    setConvId(null);
    setConv(null);
    setLive('');
  };
  const delConv = async () => {
    if (!convId || !(await confirmAction(t('Delete this conversation?')))) return;
    try {
      await api(`/api/assistant/conversations/${convId}`, { method: 'DELETE' });
      newConv();
      loadConvs();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask();
    }
  };

  const b = status.budget || {};
  const pct = Math.round((b.ratio || 0) * 100);
  const budgetClass = pct >= 95 ? 'red' : pct >= 80 ? 'amber' : pct >= 50 ? 'warn' : '';
  const options = [{ value: '', label: t('New conversation') }, ...convs.map((c) => ({ value: c.id, label: c.pending ? `${c.title} (${c.pending})` : c.title }))];

  return (
    <div className="assistant">
      <div className="assistant-head">
        <div className="row">
          <Select className="grow" value={convId || ''} options={options} onChange={(v) => setConvId(v || null)} />
          <IconButton icon="+" title={t('New conversation')} onClick={newConv} />
          {convId ? <IconButton icon="🗑" title={t('Delete the conversation')} onClick={delConv} /> : null}
        </div>
        <div className={`assistant-budget ${budgetClass}`} title={t('Assistant spend this month (all tables), cap set in /admin')}>
          <div className="assistant-budget-bar">
            <span style={{ width: `${pct}%` }}></span>
          </div>
          <span className="small">
            {t('{spent} / {cap} this month', { spent: usd(b.spent), cap: usd(b.cap) })}
            {conv?.usd ? ` · ${t('conversation: {usd}', { usd: usd(conv.usd) })}` : ''} · {status.modelLabel}
          </span>
        </div>
        {!status.connected ? <div className="assistant-notice error">{t('The assistant is not connected to the Claude API (see /admin).')}</div> : null}
        {b.allowed === false ? <div className="assistant-notice error">{t('The assistant\'s monthly budget is used up (${cap}).', { cap: b.cap })}</div> : null}
      </div>

      <div className="assistant-list" ref={listRef}>
        {!conv || !conv.items.length ? (
          <div className="assistant-intro muted small">
            <p>{t('Ask about the campaign, the rules or the current game. The assistant reads the campaign documents, character sheets, maps and the log.')}</p>
            <p>{t('It can propose maps, NPCs, handouts and campaign entries: nothing changes until you click « Apply ». It never shows anything to the players.')}</p>
            <p className="assistant-examples">
              {[
                t('Summarize what happened in the last session.'),
                t('Make me a dark warehouse in Redmond, two entrances, an office upstairs.'),
                t('Create an ork gang lieutenant, professional rating 3.'),
              ].map((ex) => (
                <button key={ex} className="assistant-example" onClick={() => setText(ex)}>
                  {ex}
                </button>
              ))}
            </p>
          </div>
        ) : (
          conv.items.map((it, i) => <Item key={i} it={it} onChanged={() => loadConv()} />)
        )}
        {live ? (
          <div className="assistant-msg bot live">
            <Markdown text={live} className="assistant-md" />
          </div>
        ) : null}
        {busy ? <div className="assistant-typing muted small">{phase === 'tools' ? t('Looking at the game…') : t('Thinking…')}</div> : null}
      </div>

      <div className="assistant-compose">
        <textarea
          className="input"
          rows={3}
          value={text}
          placeholder={t('Ask the assistant… (Enter to send, Shift+Enter for a new line)')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={!status.connected}
        ></textarea>
        <div className="row">
          {busy ? (
            <Button variant="danger" small onClick={stopRun}>
              {t('Stop')}
            </Button>
          ) : (
            <Button variant="primary" small disabled={!text.trim() || !status.connected || b.allowed === false} onClick={ask}>
              {t('Send')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
