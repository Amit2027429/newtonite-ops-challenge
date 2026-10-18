import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './refinements.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
const STATUS_OPTIONS = ['Open', 'In Progress', 'Awaiting Approval', 'Resolved', 'Closed'];
const PRIORITY_OPTIONS = ['Low', 'Medium', 'High', 'Urgent'];
const TYPE_OPTIONS = ['incident', 'customer issue', 'payment', 'compliance', 'task'];
const VIEWS = [
  ['all', 'All work items'],
  ['mine', 'Assigned to me'],
  ['unassigned_urgent', 'Unassigned urgent'],
  ['approval', 'Awaiting my approval'],
];

function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(null);
  const [items, setItems] = useState([]);
  const [dashboard, setDashboard] = useState({
    assigned_to_me: 0,
    unassigned_urgent: 0,
    awaiting_my_approval: 0,
  });
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [activity, setActivity] = useState([]);
  const [comments, setComments] = useState([]);
  const [comment, setComment] = useState('');
  const [email, setEmail] = useState('member@demo.local');
  const [password, setPassword] = useState('password123');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [type, setType] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [view, setView] = useState('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [itemType, setItemType] = useState('task');
  const [itemPriority, setItemPriority] = useState('Medium');
  const [createTeamId, setCreateTeamId] = useState('');
  const [createAssigneeId, setCreateAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [createMembers, setCreateMembers] = useState([]);
  const [editForm, setEditForm] = useState({});
  const [editMembers, setEditMembers] = useState([]);

  async function api(path, options = {}) {
    const headers = {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    };
    const response = await fetch(`${API}${path}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const requestError = new Error(data.error || `Request failed (${response.status})`);
      requestError.status = response.status;
      requestError.current = data.current;
      throw requestError;
    }
    return data;
  }

  function clearAuthentication() {
    localStorage.removeItem('token');
    setToken('');
    setUser(null);
    setSelected(null);
    setSelectedId(null);
  }

  async function login(event) {
    event.preventDefault();
    setError('');
    try {
      const response = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem('token', response.token);
      setToken(response.token);
      setSuccess('Signed in successfully.');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function loadDashboard() {
    const result = await api('/dashboard');
    setDashboard(result);
  }

  async function loadItems() {
    setLoading(true);
    try {
      const parameters = new URLSearchParams({ page: String(page), limit: '20', view });
      if (q.trim()) parameters.set('q', q.trim());
      if (status) parameters.set('status', status);
      if (priority) parameters.set('priority', priority);
      if (type) parameters.set('type', type);
      if (teamFilter) parameters.set('teamId', teamFilter);
      if (assigneeFilter) parameters.set('assigneeId', assigneeFilter);
      const result = await api(`/items?${parameters.toString()}`);
      setItems(result.items);
      setTotal(result.total);
    } catch (requestError) {
      if (requestError.status === 401) clearAuthentication();
      setError(requestError.status === 403
        ? `Permission denied: ${requestError.message}`
        : requestError.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(id) {
    if (!id) return;
    try {
      const [item, history, discussion] = await Promise.all([
        api(`/items/${id}`),
        api(`/items/${id}/activity?limit=50`),
        api(`/items/${id}/comments?limit=50`),
      ]);
      setSelected(item);
      setActivity(history.events);
      setComments(discussion.comments);
    } catch (requestError) {
      if (requestError.status === 401) clearAuthentication();
      setError(requestError.status === 403
        ? `Permission denied: ${requestError.message}`
        : requestError.message);
    }
  }

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.all([api('/me'), api('/dashboard')])
      .then(([profile, counts]) => {
        if (cancelled) return;
        setUser(profile);
        setDashboard(counts);
        const createable = profile.teams.find((team) => team.role !== 'Viewer');
        setCreateTeamId((current) => current || String(createable?.id || ''));
      })
      .catch((requestError) => {
        if (requestError.status === 401) clearAuthentication();
        else setError(requestError.message);
      });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (token) loadItems();
  }, [token, q, status, priority, type, teamFilter, assigneeFilter, view, page]);

  useEffect(() => {
    if (token && selectedId) loadDetail(selectedId);
  }, [token, selectedId]);

  useEffect(() => {
    if (!token || !createTeamId) return;
    api(`/teams/${createTeamId}/members`)
      .then((result) => setCreateMembers(result.members))
      .catch((requestError) => setError(requestError.message));
  }, [token, createTeamId]);

  useEffect(() => {
    const teamId = editing && selected ? selected.team_id : '';
    if (!token || !teamId) return;
    api(`/teams/${teamId}/members`)
      .then((result) => setEditMembers(result.members))
      .catch((requestError) => setError(requestError.message));
  }, [token, editing, selected?.team_id]);

  async function refreshVisibleData() {
    await Promise.all([loadItems(), loadDashboard()]);
    if (selectedId) await loadDetail(selectedId);
  }

  async function perform(path, body = {}, method = 'POST', headers = {}) {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api(path, {
        method,
        body: method === 'GET' ? undefined : JSON.stringify(body),
        headers,
      });
      setSuccess('Your change was saved.');
      await refreshVisibleData();
      return true;
    } catch (requestError) {
      if (requestError.status === 409) {
        setError('This item changed while you were working. The latest version has been reloaded; review it before retrying.');
        if (selectedId) await loadDetail(selectedId);
        await loadItems();
      } else if (requestError.status === 403) {
        setError(`Permission denied: ${requestError.message}`);
      } else {
        setError(requestError.message);
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function createItem(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api('/items', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          title,
          description,
          type: itemType,
          priority: itemPriority,
          teamId: Number(createTeamId),
          assigneeId: createAssigneeId ? Number(createAssigneeId) : null,
          dueDate: dueDate || null,
        }),
      });
      setCreating(false);
      setTitle('');
      setDescription('');
      setCreateAssigneeId('');
      setDueDate('');
      setSuccess('Work item created.');
      await Promise.all([loadItems(), loadDashboard()]);
    } catch (requestError) {
      setError(requestError.status === 403
        ? `Permission denied: ${requestError.message}`
        : requestError.status === 409
          ? 'The create request conflicted. Please retry; the idempotency key prevents duplicate items.'
          : requestError.message);
    } finally {
      setSaving(false);
    }
  }

  async function addComment(event) {
    event.preventDefault();
    if (!selected) return;
    if (await perform(`/items/${selected.id}/comments`, { body: comment })) setComment('');
  }

  function startEditing() {
    setEditForm({
      title: selected.title,
      description: selected.description,
      type: selected.type,
      priority: selected.priority,
      dueDate: selected.due_date || '',
      assigneeId: selected.assignee_id ? String(selected.assignee_id) : '',
    });
    setEditing(true);
  }

  async function saveEdit(event) {
    event.preventDefault();
    if (!selected) return;
    const saved = await perform(`/items/${selected.id}`, {
      version: selected.version,
      title: editForm.title,
      description: editForm.description,
      type: editForm.type,
      priority: editForm.priority,
      dueDate: editForm.dueDate || null,
      ...(selectedRole(selected) !== 'Member'
        ? { assigneeId: editForm.assigneeId ? Number(editForm.assigneeId) : null }
        : {}),
    }, 'PATCH');
    if (saved) setEditing(false);
  }

  function selectedRole(item) {
    return user?.teams.find((team) => Number(team.id) === Number(item.team_id))?.role;
  }

  function changeView(nextView) {
    setView(nextView);
    setPage(1);
  }

  if (!token) {
    return (
      <main className="login">
        <div className="logo">N<span>O</span></div>
        <p className="eyebrow">OPERATIONS WORKSPACE</p>
        <h1>Welcome back.</h1>
        <p className="muted">Sign in to manage operational work.</p>
        <form onSubmit={login}>
          <label htmlFor="login-email">Email</label>
          <input id="login-email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="login-password">Password</label>
          <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <button className="primary" disabled={saving}>Sign in</button>
          <p className="muted tiny">Demo password: password123</p>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      </main>
    );
  }

  const role = selected ? selectedRole(selected) : null;
  const canWrite = ['Member', 'Lead', 'Admin'].includes(role);
  const canManageAssignee = ['Lead', 'Admin'].includes(role);
  const canCreate = user?.teams.some((team) => team.role !== 'Viewer');
  const pageCount = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="app">
      <aside>
        <div className="logo">N<span>O</span></div>
        <p className="eyebrow">WORKSPACE</p>
        {VIEWS.map(([value, label]) => (
          <button className={`nav ${view === value ? 'active' : ''}`} key={value} onClick={() => changeView(value)}>
            {label}
          </button>
        ))}
        <div className="profile">
          <b>{user?.name}</b>
          <small>{user?.teams.map((team) => `${team.role} · ${team.name}`).join(' / ')}</small>
          <button onClick={clearAuthentication}>Sign out</button>
        </div>
      </aside>

      <main className="content">
        <header>
          <div><p className="eyebrow">OPERATIONS / OVERVIEW</p><h1>Work overview</h1></div>
          {canCreate && <button className="primary" onClick={() => setCreating(true)}>＋ New work item</button>}
        </header>

        {error && <div className="errorbox" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
        {success && <div className="successbox" role="status"><span>{success}</span><button onClick={() => setSuccess('')}>Dismiss</button></div>}

        <div className="summary">
          <button onClick={() => changeView('mine')}><small>Assigned to me</small><strong>{dashboard.assigned_to_me}</strong></button>
          <button onClick={() => changeView('unassigned_urgent')}><small>Unassigned urgent</small><strong>{dashboard.unassigned_urgent}</strong></button>
          <button onClick={() => changeView('approval')}><small>Awaiting my approval</small><strong>{dashboard.awaiting_my_approval}</strong></button>
        </div>

        <section className="listhead">
          <div>
            <h2>{VIEWS.find(([value]) => value === view)?.[1]}</h2>
            <p className="muted">{total} matching work item{total === 1 ? '' : 's'}</p>
          </div>
          <div className="filters">
            <input aria-label="Search work items" placeholder="Search work..." value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} />
            <select aria-label="Filter by status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((option) => <option key={option}>{option}</option>)}
            </select>
            <select aria-label="Filter by priority" value={priority} onChange={(event) => { setPriority(event.target.value); setPage(1); }}>
              <option value="">All priorities</option>
              {PRIORITY_OPTIONS.map((option) => <option key={option}>{option}</option>)}
            </select>
            <select aria-label="Filter by type" value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}>
              <option value="">All types</option>
              {TYPE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
            </select>
            <select aria-label="Filter by team" value={teamFilter} onChange={(event) => { setTeamFilter(event.target.value); setPage(1); }}>
              <option value="">All my teams</option>
              {user?.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
            <select aria-label="Filter by assignee" value={assigneeFilter} onChange={(event) => { setAssigneeFilter(event.target.value); setPage(1); }}>
              <option value="">All assignees</option>
              <option value="unassigned">Unassigned</option>
              {user && <option value={user.id}>Me</option>}
            </select>
          </div>
        </section>

        <div className="tablebox">
          <table>
            <thead><tr><th>Work item</th><th>Team</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Due</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} onClick={() => setSelectedId(item.id)}>
                  <td><b>{item.title}</b><small>#{item.id} · {item.type}</small></td>
                  <td>{item.team_name}</td>
                  <td><span className={`pill ${item.priority.toLowerCase()}`}>{item.priority}</span></td>
                  <td><span className="pill">{item.status}</span></td>
                  <td>{item.assignee_name || 'Unassigned'}</td>
                  <td>{item.due_date ? new Date(item.due_date).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <p className="empty" role="status">Loading work items…</p>}
          {!loading && !items.length && <p className="empty">No items found. Try changing filters.</p>}
        </div>
        <nav className="pagination" aria-label="Work item pages">
          <button disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>Previous</button>
          <span>Page {page} of {pageCount}</span>
          <button disabled={page >= pageCount || loading} onClick={() => setPage((current) => current + 1)}>Next</button>
        </nav>

        {selected && (
          <section className="detail">
            <header>
              <div><p className="eyebrow">WORK ITEM #{selected.id} · {selected.team_name}</p><h2>{selected.title}</h2></div>
              <button aria-label="Close item details" onClick={() => { setSelectedId(null); setSelected(null); setEditing(false); }}>×</button>
            </header>
            <p className="muted">{selected.description || 'No description provided.'}</p>
            <p>
              <span className="pill">{selected.status}</span>{' '}
              <span className={`pill ${selected.priority.toLowerCase()}`}>{selected.priority}</span>{' '}
              <small>Version {selected.version} · Created by {selected.creator_name} · Assignee {selected.assignee_name || 'unassigned'}</small>
            </p>
            {selected.due_date && <p className="muted">Due {new Date(selected.due_date).toLocaleDateString()}</p>}

            {!editing && (
              <>
                <div className="actions">
                  {canWrite && !selected.assignee_id && !['Resolved', 'Closed'].includes(selected.status)
                    && <button disabled={saving} onClick={() => perform(`/items/${selected.id}/claim`)}>Claim item</button>}
                  {canWrite && <button disabled={saving} onClick={startEditing}>Edit item</button>}
                  {canWrite && selected.status === 'Open'
                    && <button disabled={saving} onClick={() => perform(`/items/${selected.id}/transition`, { version: selected.version, toStatus: 'In Progress' })}>Start work</button>}
                  {canWrite && selected.status === 'In Progress'
                    && <button disabled={saving} onClick={() => perform(`/items/${selected.id}/transition`, { version: selected.version, toStatus: 'Awaiting Approval' })}>Request approval</button>}
                  {canWrite && selected.status === 'Awaiting Approval'
                    && <button disabled={saving} onClick={() => perform(`/items/${selected.id}/transition`, { version: selected.version, toStatus: 'In Progress' })}>Send back</button>}
                  {role === 'Lead' && selected.status === 'Awaiting Approval'
                    && <button className="primary" disabled={saving} onClick={() => perform(`/items/${selected.id}/transition`, { version: selected.version, toStatus: 'Resolved' })}>Approve &amp; resolve</button>}
                  {canWrite && selected.status === 'Resolved'
                    && <button disabled={saving} onClick={() => perform(`/items/${selected.id}/transition`, { version: selected.version, toStatus: 'Closed' })}>Close item</button>}
                </div>
                <h3>Activity history</h3>
                {activity.map((event) => (
                  <div className="event" key={event.id}>
                    <b>{event.actor_name || 'Former user'}</b> {event.event_type.replaceAll('_', ' ')}
                    {event.details?.from && <span> · {event.details.from} → {event.details.to}</span>}
                    {event.details?.commentId && <span> · Comment added</span>}
                    <small>{new Date(event.created_at).toLocaleString()}</small>
                  </div>
                ))}
                <h3>Comments</h3>
                {comments.map((entry) => (
                  <article className="comment" key={entry.id}>
                    <b>{entry.author_name}</b><small>{new Date(entry.created_at).toLocaleString()}</small><p>{entry.body}</p>
                  </article>
                ))}
                {canWrite && <form className="comment-form" onSubmit={addComment}>
                  <label htmlFor="new-comment">Add a comment</label>
                  <textarea id="new-comment" maxLength="5000" required value={comment} onChange={(event) => setComment(event.target.value)} />
                  <button className="primary" disabled={saving}>Add comment</button>
                </form>}
              </>
            )}

            {editing && (
              <form className="edit-form" onSubmit={saveEdit}>
                <label htmlFor="edit-title">Title</label>
                <input id="edit-title" required maxLength="200" value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} />
                <label htmlFor="edit-description">Description</label>
                <textarea id="edit-description" maxLength="10000" value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} />
                <label htmlFor="edit-type">Type</label>
                <select id="edit-type" value={editForm.type} onChange={(event) => setEditForm({ ...editForm, type: event.target.value })}>
                  {TYPE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
                </select>
                <label htmlFor="edit-priority">Priority</label>
                <select id="edit-priority" value={editForm.priority} onChange={(event) => setEditForm({ ...editForm, priority: event.target.value })}>
                  {PRIORITY_OPTIONS.map((option) => <option key={option}>{option}</option>)}
                </select>
                <label htmlFor="edit-due-date">Due date</label>
                <input id="edit-due-date" type="date" value={editForm.dueDate} onChange={(event) => setEditForm({ ...editForm, dueDate: event.target.value })} />
                {canManageAssignee && <><label htmlFor="edit-assignee">Assignee</label>
                  <select id="edit-assignee" value={editForm.assigneeId} onChange={(event) => setEditForm({ ...editForm, assigneeId: event.target.value })}>
                    <option value="">Unassigned</option>
                    {editMembers.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.role}</option>)}
                  </select>
                </>}
                <div className="actions">
                  <button className="primary" disabled={saving}>Save changes</button>
                  <button type="button" onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </form>
            )}
          </section>
        )}
      </main>

      {creating && (
        <div className="overlay" role="presentation">
          <form className="modal" onSubmit={createItem}>
            <header><h2>New work item</h2><button type="button" aria-label="Close new item form" onClick={() => setCreating(false)}>×</button></header>
            <label htmlFor="new-title">Title</label>
            <input id="new-title" required maxLength="200" value={title} onChange={(event) => setTitle(event.target.value)} />
            <label htmlFor="new-description">Description</label>
            <textarea id="new-description" maxLength="10000" value={description} onChange={(event) => setDescription(event.target.value)} />
            <label htmlFor="new-type">Type</label>
            <select id="new-type" value={itemType} onChange={(event) => setItemType(event.target.value)}>
              {TYPE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
            </select>
            <label htmlFor="new-priority">Priority</label>
            <select id="new-priority" value={itemPriority} onChange={(event) => setItemPriority(event.target.value)}>
              {PRIORITY_OPTIONS.map((option) => <option key={option}>{option}</option>)}
            </select>
            <label htmlFor="new-team">Team</label>
            <select id="new-team" value={createTeamId} onChange={(event) => { setCreateTeamId(event.target.value); setCreateAssigneeId(''); }}>
              {user?.teams.filter((team) => team.role !== 'Viewer').map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
            <label htmlFor="new-assignee">Assignee (optional)</label>
            <select id="new-assignee" value={createAssigneeId} onChange={(event) => setCreateAssigneeId(event.target.value)}>
              <option value="">Unassigned</option>
              {createMembers.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.role}</option>)}
            </select>
            <label htmlFor="new-due-date">Due date (optional)</label>
            <input id="new-due-date" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
            <button className="primary" disabled={saving}>Create work item</button>
          </form>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
