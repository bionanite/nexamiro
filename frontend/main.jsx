import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUp, BookOpen, Bot, BrainCircuit, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleAlert, Code2, Copy, Database, FileText, FolderOpen, GitBranch, KeyRound, Layers3, LayoutDashboard, LoaderCircle, Menu, MessageSquare, MoreHorizontal, Network, Plus, Search, Server, Settings2, ShieldCheck, Sparkles, Square, Terminal, Trash2, Upload, Workflow, X, Zap } from 'lucide-react';
import './styles.css';

const VIEWS = [{ id: 'workspace', label: 'Workspace', icon: LayoutDashboard }, { id: 'runs', label: 'Agent runs', icon: Workflow }, { id: 'knowledge', label: 'Knowledge', icon: BookOpen }, { id: 'models', label: 'Models & tools', icon: Network }];
const ACTIVE = new Set(['queued', 'running']);
const MODES = [{ id: 'auto', name: 'Auto route', icon: Sparkles }, { id: 'reasoning', name: 'Reasoning', icon: BrainCircuit }, { id: 'coding', name: 'Coding', icon: Code2 }];
const STARTERS = [
  { icon: BrainCircuit, color: 'violet', title: 'Think through a strategy', description: 'Turn a complex question into a clear plan.', prompt: 'Create a practical 30-day go-to-market plan for an AI workspace for small businesses. Include priorities, experiments, and success measures.', mode: 'reasoning' },
  { icon: Code2, color: 'blue', title: 'Build something useful', description: 'Plan an implementation with your coding agent.', prompt: 'Design a reliable API for a task management app. Describe its endpoints, data model, error handling, and a small implementation example.', mode: 'coding' },
  { icon: BookOpen, color: 'mint', title: 'Explore your knowledge', description: 'Find answers grounded in your documents.', prompt: 'Summarize the key facts in the selected documents and identify useful next steps. Cite the source documents and flag any missing information.', mode: 'auto' },
];

function Logo({ small = false }) { return <span className={`brand-symbol ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 36 36"><path d="M8 27V9h5l10 12V9h5v18h-5L13 15v12Z" fill="currentColor" /></svg></span>; }
function Status({ status }) { const title = status || 'unknown'; return <span className={`status status-${title}`}><span />{title.replaceAll('_', ' ')}</span>; }
function Empty({ icon: Icon = FolderOpen, title, description, children }) { return <div className="empty"><span className="empty-icon"><Icon size={24} /></span><h3>{title}</h3><p>{description}</p>{children}</div>; }
function formatDate(date) { if (!date) return '—'; return new Date(date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function duration(task) { if (!task) return '—'; const elapsed = Math.max(0, Math.round((Date.parse(task.updatedAt) - Date.parse(task.createdAt)) / 1000)); return elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`; }
function providerFingerprint(provider) { return JSON.stringify([provider?.baseUrl || '', provider?.models || {}, provider?.reasoningEnabled ?? null]); }
function taskIsDemo(task) { return task?.executionMode === 'demo' || (!task?.executionMode && task?.model === 'Local demo'); }
function inlineText(text) { return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part); }
function renderText(text = '') {
  const blocks = [];
  let code = null;
  for (const [i, line] of String(text).split('\n').entries()) {
    if (line.trim().startsWith('```')) {
      if (code !== null) { blocks.push(<pre className="answer-code" key={`code-${i}`}><code>{code.join('\n')}</code></pre>); code = null; }
      else code = [];
    } else if (code !== null) code.push(line);
    else if (/^#{1,4} /.test(line)) blocks.push(<h4 key={i}>{inlineText(line.replace(/^#{1,4} /, ''))}</h4>);
    else if (/^[-*] /.test(line)) blocks.push(<p className="answer-bullet" key={i}>• {inlineText(line.slice(2))}</p>);
    else blocks.push(<p key={i}>{line ? inlineText(line) : '\u00a0'}</p>);
  }
  if (code !== null) blocks.push(<pre className="answer-code" key="open-code"><code>{code.join('\n')}</code></pre>);
  return blocks;
}

function App() {
  const [view, setView] = useState('workspace');
  const [status, setStatus] = useState(null);
  const [modelTestBusy, setModelTestBusy] = useState(false);
  const [modelTestError, setModelTestError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [token, setToken] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState('auto');
  const [selectedDocs, setSelectedDocs] = useState([]);
  const [docPicker, setDocPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [taskSearch, setTaskSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState('all');
  const [mobileNav, setMobileNav] = useState(false);
  const [docModal, setDocModal] = useState(false);
  const [docName, setDocName] = useState('');
  const [docText, setDocText] = useState('');
  const [docBusy, setDocBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [taskActionBusy, setTaskActionBusy] = useState(false);
  const promptRef = useRef(null);
  const fileRef = useRef(null);
  const modalRef = useRef(null);
  const polling = useRef(false);
  const mounted = useRef(true);
  const configurationRevision = useRef(0);
  const selectedTask = tasks.find(t => t.id === selectedTaskId) || null;
  const isDemo = status?.mode !== 'live';
  const providerIdentity = providerFingerprint(status?.provider);
  const connectionReport = status?.provider?.connection;
  const connectionVerified = !isDemo && !modelTestError && connectionReport?.ok === true;
  const connectionFailed = !isDemo && connectionReport?.ok === false;
  const activeTasks = tasks.filter(t => ACTIVE.has(t.status));
  const completedTasks = tasks.filter(t => t.status === 'completed');
  const totalTokens = tasks.reduce((sum, t) => sum + (t.usage?.inputTokens || 0) + (t.usage?.outputTokens || 0), 0);

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { setNeedsAuth(true); throw new Error('Enter your workspace access token to continue.'); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Request failed (${response.status}).`);
    return data;
  }
  async function refresh() {
    const revision = ++configurationRevision.current;
    const [info, runs, docs] = await Promise.all([api('/api/status'), api('/api/tasks'), api('/api/documents')]);
    if (!mounted.current || revision !== configurationRevision.current) return;
    setStatus(info); setTasks(runs.tasks || []); setDocuments(docs.documents || []); setError('');
  }
  useEffect(() => { mounted.current = true; refresh().catch(e => setError(e.message)).finally(() => setLoading(false)); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!activeTasks.length || needsAuth) return;
    const interval = setInterval(async () => { if (polling.current) return; polling.current = true; try { const data = await api('/api/tasks'); if (mounted.current) setTasks(data.tasks || []); } catch (e) { if (mounted.current) setError(e.message); } finally { polling.current = false; } }, 1000);
    return () => clearInterval(interval);
  }, [activeTasks.length, needsAuth]);
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timeout); }, [notice]);
  useEffect(() => {
    if (!docModal && !pendingDelete) return;
    const previous = document.activeElement;
    const element = modalRef.current;
    element?.querySelector('input, button, textarea')?.focus();
    function handleKey(event) {
      if (event.key === 'Escape' && !docBusy) { setDocModal(false); setPendingDelete(null); }
      if (event.key !== 'Tab' || !element) return;
      const focusable = [...element.querySelectorAll('button:not([disabled]), input, textarea, [tabindex="0"]')];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [docModal, pendingDelete, docBusy]);

  function navigate(next) { setView(next); setMobileNav(false); setDocPicker(false); }
  function chooseStarter(starter) { setPrompt(starter.prompt); setMode(starter.mode); promptRef.current?.focus(); }
  function selectTask(task) { setSelectedTaskId(task.id); navigate('runs'); }
  function upsertTask(task) { setTasks(existing => [task, ...existing.filter(t => t.id !== task.id)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))); }
  async function createTask(event) {
    event?.preventDefault(); if (!prompt.trim() || submitting) return;
    setSubmitting(true); setError('');
    try { const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ prompt: prompt.trim(), mode, documentIds: selectedDocs }) }); upsertTask(data.task); setPrompt(''); selectTask(data.task); }
    catch (e) { setError(e.message); } finally { setSubmitting(false); }
  }
  async function taskAction(action) {
    if (!selectedTask || taskActionBusy) return;
    setTaskActionBusy(true);
    try { const data = await api(`/api/tasks/${selectedTask.id}/${action}`, { method: 'POST', body: '{}' }); upsertTask(data.task); setSelectedTaskId(data.task.id); }
    catch (e) { setError(e.message); } finally { setTaskActionBusy(false); }
  }
  async function testModelConnection() {
    if (isDemo || modelTestBusy) return;
    setModelTestBusy(true);
    setModelTestError('');
    const revision = configurationRevision.current;
    try {
      const report = await api('/api/models/test', { method: 'POST', body: '{}' });
      // A refresh can discover a restarted server or new credentials even when
      // endpoint/model names are unchanged. Never overwrite that fresh status.
      setStatus(current => mounted.current && revision === configurationRevision.current && providerFingerprint(current?.provider) === providerIdentity
        ? { ...current, provider: { ...current.provider, connection: report } }
        : current);
    } catch (e) {
      setModelTestError(e.message);
    } finally {
      setModelTestBusy(false);
    }
  }
  async function login(event) {
    event.preventDefault(); setAuthBusy(true); setError('');
    try { await api('/api/session', { method: 'POST', body: JSON.stringify({ token }) }); setToken(''); setNeedsAuth(false); await refresh(); }
    catch (e) { setError(e.message); } finally { setAuthBusy(false); }
  }
  async function saveDocument(event) {
    event.preventDefault(); if (!docName.trim() || !docText.trim()) return;
    setDocBusy(true); setError('');
    try { const data = await api('/api/documents', { method: 'POST', body: JSON.stringify({ name: docName.trim(), text: docText }) }); setDocuments(docs => [data.document, ...docs]); setDocModal(false); setDocName(''); setDocText(''); setSearchResults(null); setNotice('Document added to your knowledge base.'); await refresh(); }
    catch (e) { setError(e.message); } finally { setDocBusy(false); }
  }
  async function readFile(event) {
    const file = event.target.files?.[0]; if (!file) return;
    if (!/\.(txt|md|markdown)$/i.test(file.name)) { setError('Choose a plain text (.txt) or Markdown (.md) file.'); event.target.value = ''; return; }
    if (file.size > 800000) { setError('This file is too large. Use a document under 200,000 characters.'); event.target.value = ''; return; }
    try { const text = await file.text(); if (text.length > 200000) throw new Error('Documents are limited to 200,000 characters.'); setDocName(file.name); setDocText(text); setDocModal(true); }
    catch (e) { setError(e.message); } finally { event.target.value = ''; }
  }
  async function deleteDocument() {
    setDocBusy(true);
    try { await api(`/api/documents/${pendingDelete.id}`, { method: 'DELETE' }); setSelectedDocs(ids => ids.filter(id => id !== pendingDelete.id)); setPendingDelete(null); setSearchResults(null); await refresh(); setNotice('Document deleted.'); }
    catch (e) { setError(e.message); } finally { setDocBusy(false); }
  }
  async function searchKnowledge(event) {
    event.preventDefault(); if (!searchQuery.trim()) { setSearchResults(null); return; }
    setSearchBusy(true); setError('');
    try { const data = await api('/api/knowledge/search', { method: 'POST', body: JSON.stringify({ query: searchQuery.trim() }) }); setSearchResults(data.results || []); }
    catch (e) { setError(e.message); } finally { setSearchBusy(false); }
  }
  async function copy(text) { try { await navigator.clipboard.writeText(text); setError(''); setNotice('Copied to clipboard.'); } catch { setError('Clipboard access is unavailable. Select the text to copy it.'); } }
  function exportTask(task) {
    const body = `# ${task.title || 'Nexamiro run'}\n\nMode: ${taskIsDemo(task) ? 'Demo (simulated)' : 'Live'}\nStatus: ${task.status}\nCreated: ${task.createdAt}\n\n## Request\n\n${task.prompt}\n\n## Answer\n\n${task.answer || 'No answer generated.'}\n\n## Sources\n\n${(task.sources || []).map(s => `- ${s.name}: ${s.excerpt}`).join('\n') || 'None'}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `nexamiro-${task.id}.md`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const runList = tasks.filter(t => (taskFilter === 'all' || (taskFilter === 'active' ? ACTIVE.has(t.status) : t.status === taskFilter)) && `${t.title} ${t.prompt}`.toLowerCase().includes(taskSearch.toLowerCase()));
  const pageName = VIEWS.find(v => v.id === view)?.label;

  if (needsAuth) return <main className="auth-page"><form className="auth-card" onSubmit={login}><Logo /><span className="eyebrow">YOUR PRIVATE WORKSPACE</span><h1>Welcome to Nexamiro.</h1><p>Enter the access token configured by your workspace administrator.</p><label htmlFor="access-token">Workspace access token</label><input id="access-token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required autoFocus />{error && <p className="inline-error" role="alert">{error}</p>}<button className="primary-button" disabled={authBusy || !token.trim()}>{authBusy ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />} Unlock workspace</button><small>Your token is exchanged for a secure session and is not stored in this browser’s local storage.</small></form></main>;

  return <div className="app-shell">
    {mobileNav && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <button className="brand" onClick={() => navigate('workspace')} aria-label="Nexamiro workspace"><Logo /><span>Nexamiro<span className="brand-period">.</span></span></button>
      <div className="workspace-switch"><div className="workspace-avatar">N</div><div><strong>My workspace</strong><span>Self-hosted edition</span></div><ShieldCheck size={15} /></div>
      <div className="nav-caption">WORKSPACE</div>
      <nav aria-label="Main navigation">{VIEWS.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => navigate(id)} aria-current={view === id ? 'page' : undefined}><Icon size={18} /><span>{label}</span>{id === 'runs' && tasks.length > 0 && <span className="nav-count">{tasks.length}</span>}{view === id && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="sidebar-note-icon"><Layers3 size={18} /></span><strong>Open by design.</strong><p>Your models. Your knowledge.<br />Your infrastructure.</p><button onClick={() => navigate('models')}>Explore your stack <ArrowRight size={14} /></button></div><div className="profile"><div className="profile-avatar">N</div><div><strong>Local workspace</strong><span>Nexamiro v{status?.version || '0.1.0'}</span></div><span className="profile-dot" /></div></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button><span>Nexamiro</span><ChevronRight size={13} /><strong>{pageName}</strong></div><div className="topbar-actions"><span className="local-badge"><ShieldCheck size={14} /> Self-hosted</span><span className={`mode-badge ${isDemo ? 'demo' : 'live'}`}><span />{loading ? 'Connecting' : isDemo ? 'Demo mode' : 'Live configuration'}</span><button className="topbar-settings icon-button" aria-label="Model and tool settings" onClick={() => navigate('models')}><Settings2 size={17} /></button></div></header>
      <main className="main-content" id="main-content">
        {error && <div className="error-banner" role="alert"><CircleAlert size={17} /><span>{error}</span><button onClick={() => { setError(''); refresh().catch(e => setError(e.message)); }}>Retry</button><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
        {loading ? <div className="page-loading"><LoaderCircle className="spin" size={28} /><p>Opening your workspace…</p></div> : !status ? <Empty icon={Server} title="Your workspace is offline" description="Start the Nexamiro API, then reconnect to load your agents and documents."><button className="primary-button" onClick={() => { setLoading(true); refresh().catch(e => setError(e.message)).finally(() => setLoading(false)); }}>Reconnect <ArrowRight size={16} /></button></Empty> : <>
          {view === 'workspace' && <>
            <div className="page-heading"><div><span className="eyebrow"><span className="tiny-spark">✦</span> THE AUTONOMOUS WORKSPACE</span><h1>Big ideas. <span>A team to build them.</span></h1><p>Give your agents a goal. Keep the thinking, tools, and progress in view.</p></div><div className="date-label">{new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div></div>
            <div className="overview-layout"><section className="mission-column">
              <form className="composer-card" onSubmit={createTask}><div className="composer-heading"><span className="icon-tile mint"><Sparkles size={18} /></span><div><h2>What shall we work on?</h2><p>One goal. The right agents for the job.</p></div><span className="subtle-tag">NEW RUN</span></div><textarea ref={promptRef} aria-label="Describe your task" placeholder="Describe a task, ask a question, or bring an idea to life…" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={12000} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') createTask(e); }} /><div className="composer-toolbar"><div className="composer-controls"><label className="select-wrap"><Sparkles size={14} /><select aria-label="Agent routing mode" value={mode} onChange={e => setMode(e.target.value)}>{MODES.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><ChevronDown size={12} /></label><div className="doc-picker-container"><button type="button" className={`context-button ${selectedDocs.length ? 'selected' : ''}`} onClick={() => setDocPicker(!docPicker)} aria-expanded={docPicker}><Plus size={14} /><span>{selectedDocs.length ? `${selectedDocs.length} document${selectedDocs.length > 1 ? 's' : ''}` : 'Add context'}</span></button>{docPicker && <div className="doc-picker"><strong>Knowledge context</strong><p>Select documents for this run.</p>{documents.length ? documents.map(doc => <label key={doc.id}><input type="checkbox" checked={selectedDocs.includes(doc.id)} onChange={e => setSelectedDocs(ids => e.target.checked ? [...ids, doc.id] : ids.filter(id => id !== doc.id))} /><FileText size={14} /><span>{doc.name}</span></label>) : <p className="picker-empty">No documents yet. Add your first document in Knowledge.</p>}<button type="button" onClick={() => navigate('knowledge')}>Manage knowledge <ArrowRight size={13} /></button></div>}</div></div><button className="launch-button" disabled={!prompt.trim() || submitting}>{submitting ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={16} />}<span>Launch run</span></button></div><div className="composer-footnote"><ShieldCheck size={12} /><span>{isDemo ? 'Demo mode · Local simulation. No AI model is called.' : 'Tasks run through your configured model endpoint.'}</span><kbd>⌘ ↵</kbd></div></form>
              <div className="starter-grid">{STARTERS.map(starter => <button className="starter-card" key={starter.title} onClick={() => chooseStarter(starter)}><span className={`starter-icon ${starter.color}`}><starter.icon size={19} /></span><ArrowRight className="starter-arrow" size={14} /><strong>{starter.title}</strong><p>{starter.description}</p></button>)}</div>
            </section><aside className="runtime-card"><div className="panel-heading"><h2>Workspace pulse</h2><Activity size={16} /></div><div className="pulse-graphic"><div className="pulse-orbit orbit-one" /><div className="pulse-orbit orbit-two" /><div className="pulse-core"><Logo small /></div><span className="orbit-node node-one"><BrainCircuit size={14} /></span><span className="orbit-node node-two"><Code2 size={14} /></span><span className="orbit-node node-three"><Database size={13} /></span></div><div className="pulse-label"><span className="green-dot" />{isDemo ? 'Ready to explore' : 'Models configured'}</div><p className="pulse-subtitle">{isDemo ? 'Try the workflow before connecting a model.' : 'Your agents use your model infrastructure.'}</p><div className="runtime-stats"><div><strong>{activeTasks.length}</strong><span>Active runs</span></div><div><strong>{documents.length}</strong><span>Documents</span></div><div><strong>{completedTasks.length}</strong><span>Completed</span></div></div></aside></div>
            <section className="team-section"><div className="section-heading"><div><h2>A small team. A complete workflow.</h2><p>Each run moves through three focused stages.</p></div><span className="section-label"><GitBranch size={13} /> SEQUENTIAL ORCHESTRATION</span></div><div className="agent-pipeline">{[{ number: '01', icon: Workflow, name: 'Planner', color: 'mint', text: 'Breaks your goal into a practical plan.' }, { number: '02', icon: BrainCircuit, name: 'Specialist', color: 'blue', text: 'Reasons, writes, or codes for the task.' }, { number: '03', icon: ShieldCheck, name: 'Reviewer', color: 'violet', text: 'Checks the answer and its limitations.' }].map((agent, i) => <React.Fragment key={agent.name}><div className="agent-stage"><span className={`icon-tile ${agent.color}`}><agent.icon size={20} /></span><div><h3>{agent.name}<span>{agent.number}</span></h3><p>{agent.text}</p></div></div>{i < 2 && <div className="pipeline-connector"><ChevronRight size={15} /></div>}</React.Fragment>)}</div></section>
            <section className="recent-section"><div className="section-heading"><div><h2>Recent runs <span className="heading-count">{tasks.length}</span></h2><p>Your work, with every step accounted for.</p></div><button className="text-button" onClick={() => navigate('runs')}>View all runs <ArrowRight size={14} /></button></div>{tasks.length ? <div className="recent-table"><div className="table-head"><span>TASK</span><span>ROUTING</span><span>STATUS</span><span>CREATED</span><span /></div>{tasks.slice(0, 4).map(task => <button className="table-row" key={task.id} onClick={() => selectTask(task)}><span className="table-task"><span className={`task-small-icon ${task.mode === 'coding' ? 'blue' : 'mint'}`}>{task.mode === 'coding' ? <Code2 size={16} /> : <MessageSquare size={16} />}</span><strong>{task.title || task.prompt}</strong></span><span className="table-mode">{task.mode === 'auto' ? 'Auto route' : task.mode}</span><Status status={task.status} /><span className="table-date">{formatDate(task.createdAt)}</span><ChevronRight size={15} /></button>)}</div> : <div className="first-run-empty"><span className="empty-orbit"><Workflow size={24} /></span><div><h3>Good work starts with a first run.</h3><p>Describe a goal above, or pick a starting point to see your agents in action.</p></div><button className="secondary-button" onClick={() => { chooseStarter(STARTERS[0]); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Start exploring <ArrowRight size={14} /></button></div>}</section>
          </>}

          {view === 'runs' && <><div className="page-heading"><div><span className="eyebrow">A CLEAR VIEW OF THE WORK</span><h1>Agent runs</h1><p>Follow the plan, inspect each stage, and pick up where you left off.</p></div><button className="primary-button" onClick={() => { navigate('workspace'); setTimeout(() => promptRef.current?.focus(), 0); }}><Plus size={16} /> New run</button></div><div className="runs-layout"><section className="run-browser"><div className="search-input"><Search size={16} /><input aria-label="Search runs" value={taskSearch} onChange={e => setTaskSearch(e.target.value)} placeholder="Search your runs…" /></div><div className="filter-tabs" aria-label="Filter runs">{['all', 'active', 'completed', 'failed'].map(filter => <button className={taskFilter === filter ? 'selected' : ''} key={filter} onClick={() => setTaskFilter(filter)}>{filter}</button>)}</div><div className="run-list">{runList.length ? runList.map(task => <button key={task.id} className={`run-list-item ${selectedTaskId === task.id ? 'selected' : ''}`} onClick={() => setSelectedTaskId(task.id)}><div><span className="run-type">{task.mode === 'coding' ? <Code2 size={15} /> : <BrainCircuit size={15} />}{task.mode === 'auto' ? 'Auto route' : task.mode}</span><Status status={task.status} /></div><h3>{task.title || task.prompt}</h3><p>{task.prompt}</p><span className="run-date">{formatDate(task.createdAt)}<ChevronRight size={13} /></span></button>) : <Empty icon={Search} title={tasks.length ? 'No matching runs' : 'Your first run awaits'} description={tasks.length ? 'Try another search or filter.' : 'Start with a goal in your workspace.'} />}</div></section><section className="run-detail">{selectedTask ? <><div className="run-detail-header"><div><span className="eyebrow">RUN DETAILS</span><h2>{selectedTask.title || selectedTask.prompt}</h2></div><Status status={selectedTask.status} /></div><div className="run-meta"><span><GitBranch size={13} />{selectedTask.mode === 'auto' ? 'Auto route' : selectedTask.mode}</span><span><Activity size={13} />{duration(selectedTask)}</span><span><Server size={13} />{selectedTask.model || (taskIsDemo(selectedTask) ? 'Local simulation' : 'Configured model')}</span></div>{taskIsDemo(selectedTask) && <div className="demo-notice"><Sparkles size={15} /><span>Demo run · The outputs below are simulated, not model-generated.</span></div>}{selectedTask.contextNotice && <div className="context-notice"><BookOpen size={14} /><span>{selectedTask.contextNotice.startsWith('No lexical matches') ? 'No matching passages were found. This run uses opening excerpts from selected documents, so its answer does not cover their full contents.' : 'This run uses relevant document excerpts. The full documents were not read.'}</span></div>}<div className="request-block"><span className="detail-label">YOUR REQUEST</span><p>{selectedTask.prompt}</p></div><div className="execution-block"><span className="detail-label">EXECUTION TIMELINE</span>{selectedTask.steps?.length ? <div className="timeline">{selectedTask.steps.map((step, i) => <details className={`timeline-step step-${step.status}`} key={step.id || i} open={step.status === 'running' || undefined}><summary><span className="step-indicator">{step.status === 'completed' ? <Check size={13} /> : step.status === 'running' ? <LoaderCircle size={13} className="spin" /> : step.status === 'failed' ? <X size={13} /> : <Circle size={9} />}</span><span className="step-title"><strong>{step.agent || step.label}</strong><span>{step.label !== step.agent ? step.label : ''}</span></span><Status status={step.status} /><ChevronDown size={13} /></summary>{step.output ? <div className="step-output">{renderText(step.output)}</div> : <div className="step-output muted">{step.status === 'running' ? 'This agent is working on your request…' : 'No output for this stage yet.'}</div>}</details>)}</div> : <p className="muted timeline-wait">Waiting for the run to start…</p>}</div>{selectedTask.error && <div className="task-error"><CircleAlert size={17} /><p>{selectedTask.error}</p></div>}{selectedTask.answer && <div className="answer-block"><div className="answer-heading"><span><span className="answer-icon"><Sparkles size={15} /></span>Final answer</span><button className="icon-button" onClick={() => copy(selectedTask.answer)} aria-label="Copy final answer"><Copy size={15} /></button></div><div className="answer-content">{renderText(selectedTask.answer)}</div></div>}{selectedTask.sources?.length > 0 && <div className="sources-block"><span className="detail-label">REFERENCED KNOWLEDGE</span>{selectedTask.sources.map((source, i) => <details key={`${source.documentId}-${i}`}><summary><FileText size={14} /><span>{source.name}</span><ChevronDown size={13} /></summary><p>{source.excerpt}</p></details>)}</div>}<div className="run-detail-footer"><span>{(selectedTask.usage?.inputTokens || 0) + (selectedTask.usage?.outputTokens || 0)} tokens reported</span><div>{ACTIVE.has(selectedTask.status) ? <button className="secondary-button danger-text" disabled={taskActionBusy} onClick={() => taskAction('cancel')}><Square size={13} /> Cancel run</button> : <button className="secondary-button" disabled={taskActionBusy} onClick={() => taskAction('retry')}><Workflow size={14} /> Run again</button>}<button className="secondary-button" onClick={() => exportTask(selectedTask)}><ArrowDownToLine size={14} /> Export</button></div></div></> : <Empty icon={Workflow} title="Every step, in the open." description="Select a run to see its request, agent timeline, answer, and sources." />}</section></div></>}

          {view === 'knowledge' && <><div className="page-heading"><div><span className="eyebrow">GROUNDED IN YOUR CONTEXT</span><h1>Your knowledge, connected.</h1><p>Give agents the documents that matter. Keep source material close to every answer.</p></div><button className="primary-button" onClick={() => { setDocName(''); setDocText(''); setDocModal(true); }}><Plus size={16} /> Add document</button></div><div className="knowledge-summary"><span className="icon-tile mint"><Database size={22} /></span><div><strong>{documents.length} document{documents.length !== 1 ? 's' : ''}</strong><span>{documents.reduce((sum, d) => sum + (d.characters || 0), 0).toLocaleString()} characters in your workspace</span></div><span className="knowledge-type"><Search size={13} /> Local keyword retrieval</span></div><div className="knowledge-search-row"><form className="knowledge-search" onSubmit={searchKnowledge}><Search size={18} /><input aria-label="Search document contents" placeholder="Search across your knowledge…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} /><button className="secondary-button" disabled={searchBusy}>{searchBusy ? <LoaderCircle className="spin" size={14} /> : 'Search'}</button></form><button className="secondary-button" onClick={() => fileRef.current?.click()}><Upload size={15} /> Upload .txt or .md</button></div><input hidden ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={readFile} />{searchResults !== null && <section className="search-results"><div className="section-heading"><h2>{searchResults.length} search result{searchResults.length !== 1 ? 's' : ''}</h2><button className="text-button" onClick={() => { setSearchResults(null); setSearchQuery(''); }}>Clear search <X size={13} /></button></div>{searchResults.length ? searchResults.map((result, i) => <article className="search-result" key={`${result.documentId}-${i}`}><h3><FileText size={16} />{result.name}</h3><p>{result.excerpt}</p></article>) : <Empty icon={Search} title="No matches found" description="Try a word or phrase that appears in one of your documents." />}</section>}<div className="section-heading document-section-heading"><div><h2>Documents</h2><p>Plain text and Markdown · Up to 200,000 characters per document</p></div></div>{documents.length ? <div className="documents-grid">{documents.map(doc => <article className="document-card" key={doc.id}><div className="document-card-top"><span className="document-icon"><FileText size={21} /></span><button className="icon-button danger-hover" aria-label={`Delete ${doc.name}`} onClick={() => setPendingDelete(doc)}><Trash2 size={15} /></button></div><h3 title={doc.name}>{doc.name}</h3><p>{(doc.characters || 0).toLocaleString()} characters · {doc.chunkCount || 0} chunks</p><div className="document-card-bottom"><span><span className="green-dot" /> Ready for retrieval</span><span>{new Date(doc.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div></article>)}<button className="add-document-card" onClick={() => { setDocName(''); setDocText(''); setDocModal(true); }}><Plus size={24} /><strong>Add to your knowledge</strong><span>Upload a file or paste text</span></button></div> : <div className="knowledge-empty"><Empty icon={BookOpen} title="Better context. More useful answers." description="Add a brief, product guide, or internal note. Select it when you launch a run to give your agents something to work from."><button className="primary-button" onClick={() => setDocModal(true)}><Plus size={15} /> Add your first document</button></Empty></div>}<div className="info-note"><ShieldCheck size={16} /><p>Documents are stored in this workspace. Selected excerpts are sent to your configured model endpoint during live runs. Retrieval currently uses keywords; vector search is not enabled.</p></div></>}

          {view === 'models' && <><div className="page-heading"><div><span className="eyebrow">YOUR STACK. YOUR CHOICE.</span><h1>Models & tools</h1><p>Connect your own inference endpoint and see exactly what your agents can use.</p></div><span className={`mode-badge ${isDemo ? 'demo' : 'live'}`}><span />{isDemo ? 'Demo configuration' : 'Live configuration'}</span></div><section className="provider-card"><div className="provider-card-heading"><span className="icon-tile mint"><Server size={23} /></span><div><h2>{isDemo ? 'Bring your own model' : status.provider?.name || 'Configured model provider'}</h2><p>{isDemo ? 'Connect an OpenAI-compatible endpoint to enable live agent runs.' : 'Your workspace routes tasks through this model endpoint.'}</p></div><span className={`connection-tag ${connectionVerified ? 'connected' : connectionFailed || modelTestError ? 'connection-failed' : ''}`}>{isDemo ? 'Not configured' : modelTestBusy ? 'Checking…' : modelTestError ? 'Test unavailable' : connectionVerified ? 'Connection verified' : connectionFailed ? 'Connection failed' : 'Configured · unverified'}</span></div><div className="provider-details"><div><span>PROVIDER</span><strong>{status.provider?.name || 'OpenAI-compatible'}</strong></div><div><span>ENDPOINT</span><strong className="mono">{status.provider?.baseUrl || 'No endpoint configured'}</strong></div><div><span>WORKSPACE MODE</span><strong>{isDemo ? 'Local simulation' : 'Live model calls'}</strong></div></div><div className="connection-check"><div className="connection-check-action"><div><h3>Verify your model endpoint</h3><p id="model-test-description">{isDemo ? 'Configure a model endpoint on the server and restart Nexamiro to enable testing.' : 'Sends one small request per unique model. Provider charges may apply. No workspace documents are sent.'}</p></div><button className="secondary-button" disabled={isDemo || modelTestBusy} onClick={testModelConnection} aria-describedby="model-test-description">{modelTestBusy ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}{modelTestBusy ? 'Testing models…' : 'Test model connection'}</button></div><div className="connection-feedback" aria-live="polite" aria-atomic="true">{modelTestBusy && <p className="connection-progress"><LoaderCircle className="spin" size={13} />Waiting for your configured models to respond…</p>}{modelTestError && <p className="connection-error" role="alert"><CircleAlert size={15} /><span>The connection test could not complete. {modelTestError}</span></p>}{!modelTestBusy && !modelTestError && !isDemo && !connectionReport && <p className="connection-unverified"><Circle size={12} />Configuration detected. No connection test has completed yet.</p>}{connectionReport && <div className="connection-report"><div className="connection-report-heading"><span className={connectionReport.ok ? 'check-passed' : 'check-failed'}>{connectionReport.ok ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}{modelTestBusy || modelTestError ? 'Last completed check' : connectionReport.ok ? 'All configured models responded' : 'One or more models could not respond'}</span><time dateTime={connectionReport.checkedAt}>{formatDate(connectionReport.checkedAt)}</time></div><div className="connection-results">{(connectionReport.results || []).map((result, i) => <div className={`connection-result ${result.ok ? 'passed' : 'failed'}`} key={`${result.model}-${i}`}><span className="connection-result-icon">{result.ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}</span><div className="connection-result-model"><code>{result.model}</code><span>{(result.roles || []).join(' · ')}</span>{result.usage && <span className="connection-result-usage">Reported usage: {Number.isFinite(result.usage.inputTokens) ? result.usage.inputTokens.toLocaleString() : '—'} input · {Number.isFinite(result.usage.outputTokens) ? result.usage.outputTokens.toLocaleString() : '—'} output tokens</span>}{result.error && <p>{typeof result.error === 'string' ? result.error : result.error.message || 'The model did not respond successfully.'}</p>}</div><div className="connection-result-meta"><strong>{result.ok ? 'Passed' : 'Failed'}</strong><span>{Number.isFinite(result.latencyMs) ? `${Math.round(result.latencyMs).toLocaleString()} ms` : '—'}</span></div></div>)}</div></div>}</div></div></section><div className="section-heading model-section-heading"><div><h2>Model routing</h2><p>A separate model can be assigned to each kind of work.</p></div><span className="section-label"><GitBranch size={13} /> TASK-AWARE ROUTING</span></div><div className="model-grid">{[{ key: 'general', name: 'General', icon: MessageSquare, color: 'mint', text: 'Planning, writing, and everyday tasks' }, { key: 'reasoning', name: 'Reasoning', icon: BrainCircuit, color: 'violet', text: 'Analysis and complex problem solving' }, { key: 'coding', name: 'Coding', icon: Code2, color: 'blue', text: 'Implementation and technical tasks' }].map(model => <div className="model-card" key={model.key}><span className={`icon-tile ${model.color}`}><model.icon size={20} /></span><h3>{model.name}</h3><p>{model.text}</p><div className="model-name"><span className={!isDemo && !modelTestError && connectionReport?.results?.some(result => result.model === status.provider?.models?.[model.key] && result.ok) ? 'green-dot' : 'neutral-dot'} /><code>{status.provider?.models?.[model.key] || 'Not configured'}</code></div></div>)}</div><div className="models-bottom-grid"><section className="tools-card"><div className="section-heading"><div><h2>Workspace tools</h2><p>Capabilities available to the orchestration layer.</p></div><Terminal size={18} /></div>{status.tools?.length ? status.tools.map((tool, i) => <div className="tool-row" key={tool.name || i}><span className="tool-icon">{tool.name?.toLowerCase().includes('knowledge') ? <BookOpen size={18} /> : <Terminal size={18} />}</span><div><h3>{tool.name?.replaceAll('_', ' ')}</h3><p>{tool.description}</p></div><span className={`tool-status ${['available', 'ready', 'enabled', 'configured'].includes(tool.status) ? 'available' : ''}`}>{tool.status?.replaceAll('_', ' ') || 'Not enabled'}</span></div>) : <p className="muted">No tools are currently registered.</p>}<div className="tools-footnote"><ShieldCheck size={13} /> Tool availability does not imply unrestricted execution.</div></section><section className="setup-card"><span className="setup-icon"><Terminal size={19} /></span><h2>Connect a live model</h2><p>For Together AI, <a className="setup-link" href="https://api.together.ai/settings/projects/~current/api-keys" target="_blank" rel="noopener noreferrer">create an API key</a>, then run this command in a terminal from your Nexamiro project folder:</p><div className="code-block setup-command"><button className="icon-button" aria-label="Copy model setup command" onClick={() => copy('npm run setup:model')}><Copy size={14} /></button><pre>npm run setup:model</pre></div><p className="setup-footnote">The local setup prompts for your key with hidden input. Keys stay on the server and are never entered or stored in this browser.</p><div className="setup-restart"><Server size={14} /><span>Restart Nexamiro after saving configuration. Then refresh this page and use <strong>Test model connection</strong>.</span></div><details className="manual-setup"><summary><span>Ollama or manual configuration</span><ChevronDown size={13} /></summary><p>Set these variables in the server’s <code>.env</code> file. Use your endpoint’s exact model names, then restart Nexamiro.</p><div className="code-block"><button className="icon-button" aria-label="Copy model configuration example" onClick={() => copy('MODEL_BASE_URL=http://localhost:11434/v1\nMODEL_API_KEY=\nMODEL_GENERAL=your-model\nMODEL_REASONING=your-model\nMODEL_CODING=your-model')}><Copy size={14} /></button><pre>{'MODEL_BASE_URL=http://localhost:11434/v1\nMODEL_API_KEY=\nMODEL_GENERAL=your-model\nMODEL_REASONING=your-model\nMODEL_CODING=your-model'}</pre></div><p className="setup-footnote">Use an OpenAI-compatible server such as Ollama or vLLM. Model names must match models available on your endpoint.</p></details><button className="text-button" onClick={() => refresh().then(() => setNotice('Configuration refreshed.')).catch(e => setError(e.message))}>Refresh configuration <ArrowRight size={14} /></button></section></div><div className="info-note"><CircleAlert size={16} /><p>This first version includes task orchestration and local document retrieval. GPU management, fine-tuning, vector databases, and external app actions are not enabled.</p></div></>}
          <footer className="page-footer"><span><Logo small />Nexamiro</span><span>Open architecture. Focused execution.</span><span>{totalTokens.toLocaleString()} tokens reported · {tasks.length} run{tasks.length !== 1 ? 's' : ''}</span></footer>
        </>}
      </main>
    </div>
    {notice && <div className="toast" role="status"><CheckCircle2 size={17} />{notice}</div>}
    {(docModal || pendingDelete) && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !docBusy) { setDocModal(false); setPendingDelete(null); } }}><section ref={modalRef} className={`modal ${pendingDelete ? 'confirm-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">{pendingDelete ? <><div className="modal-heading"><span className="icon-tile danger"><Trash2 size={21} /></span><button className="icon-button" aria-label="Close dialog" disabled={docBusy} onClick={() => setPendingDelete(null)}><X size={19} /></button></div><h2 id="modal-title">Delete this document?</h2><p><strong>{pendingDelete.name}</strong> will be removed from the knowledge base. Existing run results keep their recorded excerpts.</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button className="secondary-button" disabled={docBusy} onClick={() => setPendingDelete(null)}>Keep document</button><button className="danger-button" disabled={docBusy} onClick={deleteDocument}>{docBusy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} Delete document</button></div></> : <form onSubmit={saveDocument}><div className="modal-heading"><span className="icon-tile mint"><BookOpen size={21} /></span><button type="button" className="icon-button" aria-label="Close dialog" disabled={docBusy} onClick={() => setDocModal(false)}><X size={19} /></button></div><h2 id="modal-title">Add to your knowledge</h2><p>A little context goes a long way. Add a document for your agents to search and reference.</p><label htmlFor="doc-name">Document name</label><input id="doc-name" placeholder="e.g. Product brief.md" value={docName} onChange={e => setDocName(e.target.value)} maxLength={160} required /><div className="textarea-label"><label htmlFor="doc-content">Document content</label><button type="button" className="text-button" onClick={() => fileRef.current?.click()}><Upload size={13} /> Choose file</button></div><textarea id="doc-content" placeholder="Paste plain text or Markdown here…" value={docText} onChange={e => setDocText(e.target.value)} maxLength={200000} required /><div className="char-count">{docText.length.toLocaleString()} / 200,000 characters</div>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={docBusy} onClick={() => setDocModal(false)}>Cancel</button><button className="primary-button" disabled={docBusy || !docName.trim() || !docText.trim()}>{docBusy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Add document</button></div></form>}</section></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
