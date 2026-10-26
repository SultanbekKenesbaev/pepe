import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, BellRing, Check, Code2, Copy, KeyRound, Loader2, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, json } from '../../api';
import './Integrations.css';

type Limits = { requestsPerMinute: number; maxConcurrentJobs: number; jobsPerDay: number };
type IntegrationKey = { id: string; prefix: string; name: string; createdAt: string; lastUsedAt?: string; revokedAt?: string };
type Integration = {
  id: string; name: string; active: boolean; createdAt: string; limits: Limits;
  usage: { jobsToday: number; totalJobs: number; readyJobs: number; failedJobs: number };
  keys: IntegrationKey[];
  webhook?: { url: string | null; configured: boolean; updatedAt?: string };
};
type Editor = { kind: 'integration'; item?: Integration } | { kind: 'key'; item: Integration } | { kind: 'webhook'; item: Integration } | { kind: 'revoke'; item: Integration; key: IntegrationKey };
const defaultLimits: Limits = { requestsPerMinute: 30, maxConcurrentJobs: 1, jobsPerDay: 10 };
const limitFields: { key: keyof Limits; label: string; max: number }[] = [
  { key: 'requestsPerMinute', label: 'Запросов / мин', max: 600 },
  { key: 'maxConcurrentJobs', label: 'Одновременно', max: 4 },
  { key: 'jobsPerDay', label: 'Заданий / день', max: 1000 },
];
const baseURL = 'https://routemotion.uz/api/v1';
const dateTime = (value?: string) => value ? new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export default function Integrations({ institutionId }: { institutionId: string }) {
  const [items, setItems] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState('');
  const [limits, setLimits] = useState(defaultLimits);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [secret, setSecret] = useState<{ value: string; integration: string; kind: 'key' | 'webhook' } | null>(null);
  const [webhookURL, setWebhookURL] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const request = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  const opened = !!editor || !!secret;

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const result = await api<Integration[]>(`/integrations?institutionId=${encodeURIComponent(institutionId)}`);
      if (id === request.current) { setItems(result); setError(''); }
    } catch (cause) { if (id === request.current) setError((cause as Error).message); }
    finally { if (id === request.current) setLoading(false); }
  }, [institutionId]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  useEffect(() => {
    if (!opened) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('input,button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { setEditor(null); setSecret(null); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),a[href]') || [])].filter(element => element.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [opened, busy]);

  function open(next: Editor) {
    setEditor(next); setFormError('');
    setName(next.kind === 'integration' ? next.item?.name || '' : '');
    setLimits(next.item?.limits || defaultLimits);
    setActive(next.item?.active ?? true);
    setWebhookURL(next.item?.webhook?.url || '');
  }
  function close() { if (!busy) { setEditor(null); setSecret(null); setFormError(''); setCopyError(''); } }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || busy) return;
    setBusy(true); setFormError('');
    try {
      if (editor.kind === 'integration') {
        if (name.trim().length < 2) throw new Error('Название должно содержать от 2 символов.');
        if (limitFields.some(field => !Number.isSafeInteger(limits[field.key]) || limits[field.key] < 1 || limits[field.key] > field.max)) throw new Error('Проверьте лимиты подключения.');
        await api(`/integrations${editor.item ? `/${encodeURIComponent(editor.item.id)}` : ''}`, json(editor.item ? 'PATCH' : 'POST', { name: name.trim(), limits, ...(editor.item ? { active } : { institutionId }) }));
        setEditor(null);
      } else if (editor.kind === 'key') {
        const result = await api<{ key: string; record: IntegrationKey; integrationId: string }>(`/integrations/${encodeURIComponent(editor.item.id)}/keys`, json('POST', { ...(name.trim() ? { name: name.trim() } : {}) }));
        setSecret({ value: result.key, integration: editor.item.name, kind: 'key' });
        setCopied(false); setCopyError(''); setEditor(null);
      } else if (editor.kind === 'webhook') {
        const value = webhookURL.trim();
        if (value) {
          let target: URL;
          try { target = new URL(value); } catch { throw new Error('Укажите корректный HTTPS-адрес.'); }
          if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('Нужен публичный HTTPS-адрес без пароля и фрагмента.');
        }
        const result = await api<{ webhook: NonNullable<Integration['webhook']>; signingSecret?: string }>(`/integrations/${encodeURIComponent(editor.item.id)}/webhook`, json('POST', { url: value || null }));
        if (result.signingSecret) { setSecret({ value: result.signingSecret, integration: editor.item.name, kind: 'webhook' }); setCopied(false); setCopyError(''); }
        setEditor(null);
      } else {
        await api(`/integrations/${encodeURIComponent(editor.item.id)}/keys/${encodeURIComponent(editor.key.id)}`, { method: 'DELETE' });
        setEditor(null);
      }
      await load();
    } catch (cause) { setFormError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function copySecret() {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.value); setCopied(true); setCopyError(''); }
    catch { secretField.current?.focus(); secretField.current?.select(); setCopyError('Выделено. Скопируйте ключ вручную.'); }
  }

  return <div className="ua-integrations">
    <div className="ua-api-toolbar">
      <div className="ua-api-address"><Code2 size={18}/><code>{baseURL}</code></div>
      <a className="ua-button" href="/api/v1/docs" target="_blank" rel="noopener noreferrer">Документация <ArrowUpRight size={15}/></a>
      <button className="ua-icon ua-refresh" aria-label="Обновить подключения" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={16}/></button>
      <button className="ua-button lime" onClick={() => open({ kind: 'integration' })}><Plus size={17}/>Подключение</button>
    </div>
    {error && <div className="ua-error" role="alert">{error}<button className="ua-text-button" onClick={() => void load()}>Повторить</button></div>}
    {loading ? <div className="ua-loading"><Loader2 size={23} className="ua-spin"/></div> : !items.length && !error ? <section className="ua-panel ua-api-empty"><Code2 size={30}/><h2>Подключений пока нет</h2><button className="ua-button lime" onClick={() => open({ kind: 'integration' })}><Plus size={16}/>Создать подключение</button></section> : <div className="ua-api-list">{items.map(item => {
      const validKeys = item.keys.filter(key => !key.revokedAt);
      return <article className="ua-panel ua-api-card" key={item.id}>
        <header><div className="ua-api-title"><span className="ua-api-symbol"><Code2 size={22}/></span><div><h2>{item.name}</h2><span className={`ua-status ${item.active ? 'lime' : ''}`}>{item.active ? 'Активно' : 'Отключено'}</span></div></div><button className="ua-button" aria-label={`Настроить ${item.name}`} onClick={() => open({ kind: 'integration', item })}><Pencil size={14}/>Настроить</button></header>
        <div className="ua-api-metrics"><div className="ua-api-today"><span>Сегодня</span><strong>{item.usage.jobsToday}<small> / {item.limits.jobsPerDay}</small></strong><div role="progressbar" aria-label={`Дневная квота ${item.name}`} aria-valuemin={0} aria-valuemax={item.limits.jobsPerDay} aria-valuenow={Math.min(item.usage.jobsToday, item.limits.jobsPerDay)}><i style={{ width: `${Math.min(100, item.usage.jobsToday / Math.max(1, item.limits.jobsPerDay) * 100)}%` }}/></div></div><dl><div><dt>Всего</dt><dd>{item.usage.totalJobs}</dd></div><div><dt>Готово</dt><dd>{item.usage.readyJobs}</dd></div><div><dt>Ошибки</dt><dd>{item.usage.failedJobs}</dd></div></dl><div className="ua-api-limits">{limitFields.map(field => <span key={field.key}>{field.label}<strong>{item.limits[field.key]}</strong></span>)}</div></div>
        <div className="ua-api-keys-title"><h3><KeyRound size={16}/>Ключи <span>{validKeys.length}</span></h3><button className="ua-text-button" onClick={() => open({ kind: 'key', item })}><Plus size={15}/>Создать ключ</button></div>
        {item.keys.length ? <div className="ua-table-wrap"><table><thead><tr><th>Название</th><th>Префикс</th><th>Последний запрос</th><th/></tr></thead><tbody>{item.keys.map(key => <tr key={key.id} className={key.revokedAt ? 'ua-api-revoked' : ''}><td><strong>{key.name || 'API-ключ'}</strong><small>{key.revokedAt ? `Отозван ${dateTime(key.revokedAt)}` : `Создан ${dateTime(key.createdAt)}`}</small></td><td><code>{key.prefix}…</code></td><td>{dateTime(key.lastUsedAt)}</td><td>{!key.revokedAt && <button className="ua-icon ua-danger-icon" aria-label={`Отозвать ключ ${key.name || key.prefix}`} title="Отозвать" onClick={() => open({ kind: 'revoke', item, key })}><Trash2 size={16}/></button>}</td></tr>)}</tbody></table></div> : <div className="ua-api-no-keys">Нет ключей</div>}
        <details className="ua-api-webhook"><summary><BellRing size={15}/>Webhook<span>{item.webhook?.configured ? 'Подключён' : 'Не подключён'}</span></summary><div>{item.webhook?.configured && <code>{item.webhook.url}</code>}<button className="ua-text-button" onClick={() => open({ kind: 'webhook', item })}>{item.webhook?.configured ? 'Изменить' : 'Подключить'}<ArrowUpRight size={14}/></button></div></details>
      </article>;
    })}</div>}
    {opened && <div className="ua-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !secret) close(); }}><section className="ua-drawer ua-api-drawer" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="ua-api-dialog-title" data-busy={busy}>
      <header><h2 id="ua-api-dialog-title">{secret ? secret.kind === 'key' ? 'Ключ создан' : 'Секрет подписи' : editor?.kind === 'webhook' ? 'Webhook' : editor?.kind === 'key' ? 'Новый ключ' : editor?.kind === 'revoke' ? 'Отозвать ключ?' : editor?.item ? 'Настройки подключения' : 'Новое подключение'}</h2><button className="ua-icon" aria-label="Закрыть" disabled={busy} onClick={close}><X size={21}/></button></header>
      {secret ? <><div className="ua-drawer-body ua-api-secret"><ShieldCheck size={29}/><strong>{secret.integration}</strong><p>Сохраните {secret.kind === 'key' ? 'ключ' : 'секрет'}. После закрытия он больше не появится.</p><label className="ua-field"><span>{secret.kind === 'key' ? 'API-ключ' : 'Секрет подписи'}</span><input ref={secretField} value={secret.value} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()}/></label><button className="ua-button lime" onClick={() => void copySecret()}>{copied ? <Check size={16}/> : <Copy size={16}/>}{copied ? 'Скопировано' : 'Скопировать'}</button>{copyError && <p role="status">{copyError}</p>}</div><footer className="ua-drawer-footer"><button className="ua-button" onClick={close}>Готово</button></footer></> : <form onSubmit={save} className="ua-api-form"><div className="ua-drawer-body">{editor?.kind === 'revoke' ? <p className="ua-api-confirm">Ключ «{editor.key.name || editor.key.prefix}» перестанет принимать запросы.</p> : editor?.kind === 'webhook' ? <><label className="ua-field"><span>URL уведомлений</span><input type="url" value={webhookURL} placeholder="https://example.uz/webhooks" autoComplete="off" onChange={event => setWebhookURL(event.target.value)}/></label><p className="ua-api-confirm">{editor.item.webhook?.configured ? 'При сохранении секрет подписи будет обновлён. Пустой адрес отключит уведомления.' : 'Готовность и ошибки заданий. Публичный HTTPS-адрес.'}</p></> : <><label className="ua-field"><span>{editor?.kind === 'key' ? 'Название ключа' : 'Название подключения'}</span><input required={editor?.kind === 'integration'} minLength={editor?.kind === 'integration' ? 2 : undefined} maxLength={100} value={name} autoComplete="off" placeholder={editor?.kind === 'key' ? 'Например, сервер университета' : 'Например, сайт университета'} onChange={event => setName(event.target.value)}/></label>{editor?.kind === 'integration' && <><div className="ua-api-limit-fields">{limitFields.map(field => <label className="ua-field" key={field.key}><span>{field.label}</span><input type="number" required min={1} max={field.max} step={1} value={limits[field.key] || ''} onChange={event => setLimits(previous => ({ ...previous, [field.key]: Number(event.target.value) }))}/></label>)}</div>{editor.item && <label className="ua-api-active"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)}/><span>Подключение активно</span></label>}</>}</>}{formError && <div className="ua-error" role="alert">{formError}</div>}</div><footer className="ua-drawer-footer"><button className="ua-button" type="button" onClick={close} disabled={busy}>Отмена</button><button className={`ua-button ${editor?.kind === 'revoke' ? 'danger' : 'lime'}`} disabled={busy}>{busy ? <Loader2 size={16} className="ua-spin"/> : editor?.kind === 'revoke' ? <Trash2 size={16}/> : <Check size={16}/>}{editor?.kind === 'revoke' ? 'Отозвать ключ' : editor?.kind === 'key' ? 'Создать ключ' : 'Сохранить'}</button></footer></form>}
    </section></div>}
  </div>;
}
