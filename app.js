/* ============================================================
   TASK MANAGER v2.0
   ============================================================ */

'use strict';

// ============================================================
// CONSTANTS
// ============================================================
const STORAGE_KEY = 'taskmanager_v2';
const CLOCKIFY_WORKSPACE = '6386f7b7f4b38507be1e5f5a';
const CLOCKIFY_USER_ID   = '6386f7b7f4b38507be1e5f59';

const STATUS = { OPEN: 'open', IN_PROGRESS: 'in-progress', DONE: 'done' };
const STATUS_LABELS = { open: 'פתוח', 'in-progress': 'בביצוע', done: 'הושלם' };
const STATUS_ICONS  = { open: '○', 'in-progress': '◐', done: '✓' };
const PRIORITY = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };
const PRIORITY_LABELS = { high: 'גבוה', medium: 'בינוני', low: 'נמוך' };

const PROJECT_COLORS = [
  '#6366f1','#ec4899','#f59e0b','#22c55e',
  '#3b82f6','#8b5cf6','#ef4444','#14b8a6',
  '#f97316','#06b6d4'
];

// ============================================================
// STATE
// ============================================================
let state = {};
let timerInterval = null;

function defaultState() {
  return {
    clients: [],
    activeTimer: null,          // { type, clientId, projectId, taskId, subtaskId, startTime }
    clockifyApiKey: 'ZjI3MmYxOTUtOTUxOS00MTgyLTgzNzktZDdmNjYzM2UwMmQ5',
    currentView: 'today',       // 'today' | 'client' | 'project'
    selectedClientId: null,
    selectedProjectId: null,
    selectedTaskId: null,
    panelClientId: null,        // context for open task panel
    panelProjectId: null,
    filters: {
      status: STATUS.OPEN,
      priority: 'all',
      tag: 'all',
      clientId: 'all'
    }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      state = Object.assign(defaultState(), saved);
      // If API key was never set, use the default
      if (!state.clockifyApiKey) {
        state.clockifyApiKey = defaultState().clockifyApiKey;
      }
    } else {
      state = defaultState();
    }
  } catch (e) {
    state = defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ============================================================
// UTILITIES
// ============================================================
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function formatDisplayDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function isOverdue(dueDate, status) {
  if (!dueDate || status === STATUS.DONE) return false;
  return dueDate < todayStr();
}

// Format estimated minutes → "1:30" / "45ד'"
function formatEstimate(minutes) {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}ד'`;
  if (m === 0) return `${h}ש'`;
  return `${h}:${String(m).padStart(2,'0')}`;
}

// Returns {pct, state} where state is 'ok'|'warn'|'over'
function estimateProgress(actualSecs, estimatedMinutes) {
  if (!estimatedMinutes || estimatedMinutes <= 0) return null;
  const estSecs = estimatedMinutes * 60;
  const pct = actualSecs / estSecs;
  return { pct, over: pct > 1, warn: pct > 0.8 && pct <= 1, barState: pct > 1 ? 'over' : pct > 0.8 ? 'warn' : 'ok' };
}

function elapsed(startTime) {
  return Math.floor((Date.now() - startTime) / 1000);
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// DATA HELPERS
// ============================================================
function getClient(id) { return state.clients.find(c => c.id === id); }
function getProject(cid, pid) { return getClient(cid)?.projects?.find(p => p.id === pid); }
function getTask(cid, pid, tid) { return getProject(cid, pid)?.tasks?.find(t => t.id === tid); }
function getSubtask(cid, pid, tid, sid) { return getTask(cid, pid, tid)?.subtasks?.find(s => s.id === sid); }

function allTodayItems() {
  const today = todayStr();
  const result = [];
  for (const client of state.clients) {
    for (const project of (client.projects || [])) {
      for (const task of (project.tasks || [])) {
        if (task.dueDate === today) result.push({ client, project, task });
      }
    }
  }
  return result;
}

function allProjectTags(cid, pid) {
  const tags = new Set();
  for (const t of (getProject(cid, pid)?.tasks || [])) {
    for (const tag of (t.tags || [])) tags.add(tag);
  }
  return [...tags].sort();
}

function allGlobalTags() {
  const tags = new Set();
  for (const c of state.clients)
    for (const p of (c.projects || []))
      for (const t of (p.tasks || []))
        for (const tag of (t.tags || [])) tags.add(tag);
  return [...tags].sort();
}

function taskTotalTime(task, cid, pid) {
  let total = task.timeTotal || 0;
  const at = state.activeTimer;
  if (at && at.taskId === task.id && !at.subtaskId) total += elapsed(at.startTime);
  for (const s of (task.subtasks || [])) total += subtaskTotalTime(s);
  return total;
}

function subtaskTotalTime(sub) {
  let total = sub.timeTotal || 0;
  const at = state.activeTimer;
  if (at && at.subtaskId === sub.id) total += elapsed(at.startTime);
  return total;
}

// ============================================================
// CRUD — CLIENTS
// ============================================================
function addClient(data) {
  const client = { id: uuid(), name: data.name || 'לקוח חדש', email: data.email || '', phone: data.phone || '', notes: data.notes || '', projects: [] };
  state.clients.push(client);
  saveState();
  return client;
}

function updateClient(cid, data) {
  const c = getClient(cid);
  if (c) { Object.assign(c, data); saveState(); }
}

function deleteClient(cid) {
  if (state.activeTimer?.clientId === cid) cancelTimer();
  state.clients = state.clients.filter(c => c.id !== cid);
  if (state.selectedClientId === cid) {
    state.selectedClientId = null; state.selectedProjectId = null;
    state.selectedTaskId = null; state.currentView = 'today';
  }
  saveState();
}

// ============================================================
// CRUD — PROJECTS
// ============================================================
function addProject(cid, data) {
  const c = getClient(cid);
  if (!c) return;
  const p = { id: uuid(), name: data.name || 'פרויקט חדש', color: data.color || PROJECT_COLORS[0], tasks: [] };
  (c.projects = c.projects || []).push(p);
  saveState();
  return p;
}

function updateProject(cid, pid, data) {
  const p = getProject(cid, pid);
  if (p) { Object.assign(p, data); saveState(); }
}

function deleteProject(cid, pid) {
  const c = getClient(cid);
  if (!c) return;
  if (state.activeTimer?.projectId === pid) cancelTimer();
  c.projects = (c.projects || []).filter(p => p.id !== pid);
  if (state.selectedProjectId === pid) {
    state.selectedProjectId = null; state.selectedTaskId = null; state.currentView = 'client';
  }
  saveState();
}

// ============================================================
// CRUD — TASKS
// ============================================================
function addTask(cid, pid, data) {
  const p = getProject(cid, pid);
  if (!p) return;
  const task = {
    id: uuid(), title: data.title || 'משימה חדשה',
    description: data.description || '', priority: data.priority || PRIORITY.MEDIUM,
    tags: data.tags || [], dueDate: data.dueDate || null,
    status: STATUS.OPEN, timeTotal: 0, subtasks: [],
    estimatedMinutes: data.estimatedMinutes || null
  };
  (p.tasks = p.tasks || []).push(task);
  saveState();
  return task;
}

function updateTask(cid, pid, tid, data) {
  const t = getTask(cid, pid, tid);
  if (t) { Object.assign(t, data); saveState(); }
}

function deleteTask(cid, pid, tid) {
  const p = getProject(cid, pid);
  if (!p) return;
  if (state.activeTimer?.taskId === tid) cancelTimer();
  p.tasks = (p.tasks || []).filter(t => t.id !== tid);
  if (state.selectedTaskId === tid) { state.selectedTaskId = null; state.panelClientId = null; state.panelProjectId = null; }
  saveState();
}

function moveTask(tid, fromCid, fromPid, toCid, toPid) {
  const fromP = getProject(fromCid, fromPid);
  const toP   = getProject(toCid, toPid);
  if (!fromP || !toP) return;
  const idx = (fromP.tasks || []).findIndex(t => t.id === tid);
  if (idx === -1) return;
  const [task] = fromP.tasks.splice(idx, 1);
  (toP.tasks = toP.tasks || []).push(task);
  const at = state.activeTimer;
  if (at?.taskId === tid) { at.clientId = toCid; at.projectId = toPid; }
  saveState();
}

// ============================================================
// CRUD — SUBTASKS
// ============================================================
function addSubtask(cid, pid, tid, data) {
  const t = getTask(cid, pid, tid);
  if (!t) return;
  const sub = { id: uuid(), title: data.title || 'תת-משימה', description: data.description || '', status: STATUS.OPEN, timeTotal: 0 };
  (t.subtasks = t.subtasks || []).push(sub);
  saveState();
  return sub;
}

function updateSubtask(cid, pid, tid, sid, data) {
  const s = getSubtask(cid, pid, tid, sid);
  if (s) { Object.assign(s, data); saveState(); }
}

function deleteSubtask(cid, pid, tid, sid) {
  const t = getTask(cid, pid, tid);
  if (!t) return;
  if (state.activeTimer?.subtaskId === sid) cancelTimer();
  t.subtasks = (t.subtasks || []).filter(s => s.id !== sid);
  saveState();
}

// ============================================================
// TIMER
// ============================================================
function startTimer(cid, pid, tid, sid = null) {
  if (state.activeTimer) stopTimer();

  const startTime = Date.now();
  state.activeTimer = {
    type: sid ? 'subtask' : 'task',
    clientId: cid, projectId: pid, taskId: tid, subtaskId: sid || null,
    startTime,
    clockifyEntryId: null   // filled async after Clockify call
  };
  saveState();
  startTimerTick();
  render();

  // Start Clockify timer in background (don't block UI)
  if (state.clockifyApiKey) {
    const c = getClient(cid);
    const p = getProject(cid, pid);
    const t = getTask(cid, pid, tid);
    const s = sid ? getSubtask(cid, pid, tid, sid) : null;
    clockifyStartEntry({
      clientName:  c?.name || '',
      projectName: p?.name || '',
      taskName:    s ? s.title : (t?.title || ''),
      description: s ? (s.description || '') : (t?.description || ''),
      startTime
    }).then(entryId => {
      if (entryId && state.activeTimer) {
        state.activeTimer.clockifyEntryId = entryId;
        saveState();
      }
    });
  }
}

function stopTimer() {
  const at = state.activeTimer;
  if (!at) return;

  const secs    = elapsed(at.startTime);
  const endTime = at.startTime + secs * 1000;

  // Accumulate time locally
  if (at.type === 'subtask') {
    const s = getSubtask(at.clientId, at.projectId, at.taskId, at.subtaskId);
    if (s) s.timeTotal = (s.timeTotal || 0) + secs;
  } else {
    const t = getTask(at.clientId, at.projectId, at.taskId);
    if (t) t.timeTotal = (t.timeTotal || 0) + secs;
  }

  // Stop Clockify entry
  if (state.clockifyApiKey) {
    if (at.clockifyEntryId) {
      // entry was opened live — just stop it
      clockifyStopEntry(at.clockifyEntryId, endTime);
    } else {
      // fallback: entry wasn't opened yet (very fast stop) — create full entry
      const c = getClient(at.clientId);
      const p = getProject(at.clientId, at.projectId);
      const t = getTask(at.clientId, at.projectId, at.taskId);
      const s = at.subtaskId ? getSubtask(at.clientId, at.projectId, at.taskId, at.subtaskId) : null;
      clockifyCreateEntry({
        clientName:  c?.name || '',
        projectName: p?.name || '',
        taskName:    s ? s.title : (t?.title || ''),
        description: s ? (s.description || '') : (t?.description || ''),
        start: at.startTime, end: endTime
      });
    }
  }

  state.activeTimer = null;
  saveState();
  clearTimerTick();
  render();
}

function cancelTimer() {
  state.activeTimer = null;
  saveState();
  clearTimerTick();
}

function startTimerTick() {
  clearTimerTick();
  timerInterval = setInterval(tickTimer, 1000);
}

function clearTimerTick() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function tickTimer() {
  if (!state.activeTimer) { clearTimerTick(); return; }
  const secs = elapsed(state.activeTimer.startTime);
  document.querySelectorAll('[data-tick]').forEach(el => {
    const base = parseInt(el.dataset.base || '0', 10);
    el.textContent = formatTime(base + secs);
    el.classList.toggle('timer-running', true);
  });
  const timerWidget = document.getElementById('timer-widget-value');
  if (timerWidget) {
    const base = parseInt(timerWidget.dataset.base || '0', 10);
    timerWidget.textContent = formatTime(base + secs);
  }
}

// ============================================================
// CLOCKIFY
// ============================================================

// Shared: resolve projectId (find or create client + project)
async function clockifyResolveProject(apiKey, wsId, clientName, projectName) {
  let clockifyClientId  = clientName  ? await clockifyUpsertClient(apiKey, wsId, clientName)  : null;
  let clockifyProjectId = projectName ? await clockifyUpsertProject(apiKey, wsId, projectName, clockifyClientId) : null;
  if (!clockifyProjectId) throw new Error(`לא ניתן למצוא/ליצור פרויקט "${projectName}" ב-Clockify`);
  return clockifyProjectId;
}

// Called on ▶ — opens a live running entry, returns entry ID
async function clockifyStartEntry({ clientName, projectName, taskName, description, startTime }) {
  const apiKey = state.clockifyApiKey;
  const wsId   = CLOCKIFY_WORKSPACE;
  try {
    const projectId = await clockifyResolveProject(apiKey, wsId, clientName, projectName);
    const body = {
      start: new Date(startTime).toISOString(),
      description: taskName + (description ? ': ' + description : ''),
      projectId,
      billable: false
    };
    const res = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/time-entries`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
    const entry = await res.json();
    showToast('Clockify: טיימר התחיל ▶', 'info');
    return entry.id;
  } catch (err) {
    console.error('Clockify startEntry:', err);
    showToast('שגיאת Clockify (פתיחה): ' + err.message, 'error');
    return null;
  }
}

// Called on ⏸ — stops the live entry
async function clockifyStopEntry(entryId, endTime) {
  const apiKey = state.clockifyApiKey;
  const wsId   = CLOCKIFY_WORKSPACE;
  try {
    const res = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/user/${CLOCKIFY_USER_ID}/time-entries`, {
      method: 'PATCH',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ end: new Date(endTime).toISOString() })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
    showToast('Clockify: טיימר נעצר ⏸', 'success');
  } catch (err) {
    console.error('Clockify stopEntry:', err);
    showToast('שגיאת Clockify (עצירה): ' + err.message, 'error');
  }
}

// Fallback: create a completed entry (used if stop is called before start resolved)
async function clockifyCreateEntry({ clientName, projectName, taskName, description, start, end }) {
  const apiKey = state.clockifyApiKey;
  const wsId   = CLOCKIFY_WORKSPACE;
  try {
    const projectId = await clockifyResolveProject(apiKey, wsId, clientName, projectName);
    const body = {
      start: new Date(start).toISOString(),
      end:   new Date(end).toISOString(),
      description: taskName + (description ? ': ' + description : ''),
      projectId,
      billable: false
    };
    const res = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/time-entries`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
    showToast('זמן נרשם ב-Clockify ✓', 'success');
  } catch (err) {
    console.error('Clockify createEntry:', err);
    showToast('שגיאת Clockify: ' + err.message, 'error');
  }
}

async function clockifyUpsertClient(apiKey, wsId, name) {
  try {
    const r = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/clients?name=${encodeURIComponent(name)}&page-size=50`, { headers: { 'X-Api-Key': apiKey } });
    if (r.ok) {
      const list = await r.json();
      const found = list.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (found) return found.id;
    }
    const cr = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/clients`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (cr.ok) { const x = await cr.json(); return x.id; }
    console.warn('Clockify create client failed:', cr.status, await cr.text());
  } catch (e) { console.warn('clockifyUpsertClient:', e); }
  return null;
}

async function clockifyUpsertProject(apiKey, wsId, name, clientId) {
  try {
    const r = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/projects?name=${encodeURIComponent(name)}&page-size=50`, { headers: { 'X-Api-Key': apiKey } });
    if (r.ok) {
      const list = await r.json();
      const found = list.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (found) return found.id;
    }
    const body = { name, isPublic: false, color: '#6366f1' };
    if (clientId) body.clientId = clientId;
    const cr = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/projects`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (cr.ok) { const x = await cr.json(); return x.id; }
    console.warn('Clockify create project failed:', cr.status, await cr.text());
  } catch (e) { console.warn('clockifyUpsertProject:', e); }
  return null;
}

// ============================================================
// FILTERS
// ============================================================
function applyFilters(tasks) {
  const f = state.filters;
  return tasks.filter(t => {
    if (f.status   !== 'all' && t.status   !== f.status)   return false;
    if (f.priority !== 'all' && t.priority !== f.priority) return false;
    if (f.tag      !== 'all' && !(t.tags || []).includes(f.tag)) return false;
    return true;
  });
}

function applyTodayFilters(items) {
  const f = state.filters;
  return items.filter(({ client, task }) => {
    if (f.status   !== 'all' && task.status   !== f.status)   return false;
    if (f.priority !== 'all' && task.priority !== f.priority) return false;
    if (f.tag      !== 'all' && !(task.tags || []).includes(f.tag)) return false;
    if (f.clientId !== 'all' && client.id !== f.clientId)     return false;
    return true;
  });
}

// ============================================================
// NAVIGATION
// ============================================================
function navigateTo(view) {
  state.currentView = view;
  state.selectedTaskId = null; state.panelClientId = null; state.panelProjectId = null;
  saveState(); render();
}

function selectClient(cid) {
  if (state.selectedClientId === cid && state.currentView === 'client') {
    state.selectedClientId = null; state.currentView = 'today';
  } else {
    state.selectedClientId = cid; state.selectedProjectId = null;
    state.selectedTaskId = null; state.currentView = 'client';
  }
  saveState(); render();
}

function selectProject(cid, pid) {
  state.selectedClientId = cid; state.selectedProjectId = pid;
  state.selectedTaskId = null; state.currentView = 'project';
  saveState(); render();
}

function selectTask(cid, pid, tid) {
  if (state.selectedTaskId === tid) {
    state.selectedTaskId = null; state.panelClientId = null; state.panelProjectId = null;
  } else {
    state.selectedTaskId = tid; state.panelClientId = cid; state.panelProjectId = pid;
  }
  saveState(); render();
}

function closeTaskPanel() {
  state.selectedTaskId = null; state.panelClientId = null; state.panelProjectId = null;
  saveState(); render();
}

function setFilter(key, value) {
  state.filters[key] = value;
  saveState(); renderMain(); renderTaskPanel();
}

function cycleStatus(cid, pid, tid) {
  const t = getTask(cid, pid, tid);
  if (!t) return;
  const cycle = [STATUS.OPEN, STATUS.IN_PROGRESS, STATUS.DONE];
  t.status = cycle[(cycle.indexOf(t.status) + 1) % cycle.length];
  saveState(); render();
}

function toggleSubtaskDone(cid, pid, tid, sid) {
  const s = getSubtask(cid, pid, tid, sid);
  if (!s) return;
  s.status = s.status === STATUS.DONE ? STATUS.OPEN : STATUS.DONE;
  saveState(); render();
}

// ============================================================
// RENDER — MAIN
// ============================================================
function render() {
  renderSidebar();
  renderMain();
  renderTaskPanel();
  renderActiveTimer();
  if (state.activeTimer && !timerInterval) startTimerTick();
}

function renderSidebar() {
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;
  const isToday = state.currentView === 'today';

  let html = `
    <div class="nav-today ${isToday ? 'active' : ''}" onclick="navigateTo('today')">
      <span class="nav-today-icon">📅</span>
      <span>היום</span>
    </div>`;

  for (const c of state.clients) {
    const expanded = state.selectedClientId === c.id;
    html += `<div class="nav-client ${expanded ? 'active' : ''}">
      <div class="nav-client-header" onclick="selectClient('${c.id}')">
        <span style="font-size:15px">👤</span>
        <span class="nav-client-name">${esc(c.name)}</span>
        <span class="nav-chevron ${expanded ? 'open' : ''}">›</span>
      </div>
      ${expanded ? renderSidebarProjects(c) : ''}
    </div>`;
  }
  nav.innerHTML = html;
}

function renderSidebarProjects(client) {
  let html = '<div class="nav-projects">';
  for (const p of (client.projects || [])) {
    const active = state.selectedProjectId === p.id;
    html += `<div class="nav-project ${active ? 'active' : ''}" onclick="selectProject('${client.id}','${p.id}')">
      <span class="project-dot sm" style="background:${p.color}"></span>
      <span>${esc(p.name)}</span>
    </div>`;
  }
  html += `<div class="nav-add-project" onclick="showAddProjectModal('${client.id}')">＋ פרויקט</div>`;
  html += '</div>';
  return html;
}

function renderMain() {
  const el = document.getElementById('main-content');
  if (!el) return;
  switch (state.currentView) {
    case 'today':   el.innerHTML = renderTodayView();   break;
    case 'client':  el.innerHTML = renderClientView();  break;
    case 'project': el.innerHTML = renderProjectView(); break;
    default:        el.innerHTML = renderTodayView();
  }
}

// ============================================================
// TODAY VIEW
// ============================================================
function renderTodayView() {
  const allItems = allTodayItems();
  const items    = applyTodayFilters(allItems);
  const tags     = allGlobalTags();
  const today    = todayStr();
  const [y, m, d] = today.split('-');

  let tasksHtml = '';
  if (items.length === 0) {
    tasksHtml = `<div class="empty-state"><div class="empty-icon">🎉</div><div>אין משימות להיום</div></div>`;
  } else {
    for (const { client, project, task } of items) {
      tasksHtml += renderTaskCard(task, client.id, project.id, { showProject: true, projectName: project.name, projectColor: project.color, clientName: client.name });
    }
  }

  const clientOpts = [
    { value: 'all', label: 'כל הלקוחות' },
    ...state.clients.map(c => ({ value: c.id, label: c.name }))
  ];

  return `<div class="view-container">
    <div class="view-header">
      <div class="view-header-title">
        <h2>📅 היום <span class="today-date">${d}/${m}/${y}</span></h2>
      </div>
    </div>
    <div class="filter-bar">
      <span class="filter-label">פילטר:</span>
      ${renderFilterSelects(tags)}
      ${renderCsel('f-client', clientOpts, state.filters.clientId || 'all', "setFilter('clientId',{val})")}
    </div>
    ${renderQuickAddBar()}
    <div class="task-list">${tasksHtml}</div>
  </div>`;
}

// ============================================================
// CLIENT VIEW
// ============================================================
function renderClientView() {
  const c = getClient(state.selectedClientId);
  if (!c) return '<div class="view-container"><div class="empty-state">לקוח לא נמצא</div></div>';

  const initial = (c.name || '?').charAt(0).toUpperCase();
  const infoDetail = [
    c.email ? `<div class="client-detail">📧 ${esc(c.email)}</div>` : '',
    c.phone ? `<div class="client-detail">📞 ${esc(c.phone)}</div>` : ''
  ].join('');

  const projCards = (c.projects || []).map(p => renderProjectCard(c.id, p)).join('');

  return `<div class="view-container">
    <div class="view-header">
      <h2>👤 ${esc(c.name)}</h2>
      <div class="view-actions">
        <button class="btn btn-ghost btn-sm" onclick="showEditClientModal('${c.id}')">✏️ עריכה</button>
        <button class="btn btn-ghost btn-sm btn-danger" onclick="confirmDeleteClient('${c.id}')">🗑️ מחיקה</button>
      </div>
    </div>
    <div class="client-info-card">
      <div class="client-avatar">${initial}</div>
      <div class="client-info-body">
        <div class="client-info-name">${esc(c.name)}</div>
        <div class="client-info-details">${infoDetail}</div>
        ${c.notes ? `<div class="client-notes">📝 ${esc(c.notes)}</div>` : ''}
      </div>
    </div>
    <div class="section-header">
      <h3>פרויקטים (${(c.projects||[]).length})</h3>
      <button class="btn btn-primary btn-sm" onclick="showAddProjectModal('${c.id}')">＋ פרויקט חדש</button>
    </div>
    <div class="projects-grid">
      ${projCards || '<div class="empty-state sm">אין פרויקטים עדיין</div>'}
    </div>
  </div>`;
}

function renderProjectCard(cid, p) {
  const total = (p.tasks || []).length;
  const open  = (p.tasks || []).filter(t => t.status !== STATUS.DONE).length;
  const client = getClient(cid);
  const isInbox = client?._inbox;
  return `<div class="project-card ${isInbox ? 'project-card-inbox' : ''}" onclick="selectProject('${cid}','${p.id}')">
    <div class="project-card-header">
      <span class="project-dot lg" style="background:${p.color}"></span>
      <span class="project-card-name">${esc(p.name)}</span>
      ${isInbox ? '<span class="inbox-badge">ללא לקוח</span>' : ''}
    </div>
    <div class="project-card-stats">${open} פתוחות / ${total} סה"כ</div>
    <div class="project-card-actions" onclick="event.stopPropagation()">
      ${isInbox ? `<button class="btn-icon" onclick="showAssignClientModal('${cid}','${p.id}')" title="שייך ללקוח">🔗</button>` : ''}
      <button class="btn-icon" onclick="showEditProjectModal('${cid}','${p.id}')" title="עריכה">✏️</button>
      <button class="btn-icon danger" onclick="confirmDeleteProject('${cid}','${p.id}')" title="מחיקה">🗑️</button>
    </div>
  </div>`;
}

// ============================================================
// PROJECT VIEW
// ============================================================
function renderProjectView() {
  const c = getClient(state.selectedClientId);
  const p = getProject(state.selectedClientId, state.selectedProjectId);
  if (!p || !c) return '<div class="view-container"><div class="empty-state">פרויקט לא נמצא</div></div>';

  const tags     = allProjectTags(c.id, p.id);
  const filtered = applyFilters(p.tasks || []);

  const tasksHtml = filtered.length === 0
    ? `<div class="empty-state"><div class="empty-icon">✓</div><div>אין משימות מתאימות</div></div>`
    : filtered.map(t => renderTaskCard(t, c.id, p.id, {})).join('');

  return `<div class="view-container">
    <div class="view-header">
      <div class="view-header-title">
        <span class="project-dot lg" style="background:${p.color}"></span>
        <div>
          <div class="breadcrumb">${esc(c.name)}</div>
          <h2>${esc(p.name)}</h2>
        </div>
      </div>
      <div class="view-actions">
        <button class="btn btn-ghost btn-sm" onclick="showEditProjectModal('${c.id}','${p.id}')">✏️</button>
        <button class="btn btn-ghost btn-sm btn-danger" onclick="confirmDeleteProject('${c.id}','${p.id}')">🗑️</button>
        <button class="btn btn-primary btn-sm" onclick="showAddTaskModal('${c.id}','${p.id}')">＋ משימה חדשה</button>
      </div>
    </div>
    <div class="filter-bar">
      <span class="filter-label">פילטר:</span>
      ${renderFilterSelects(tags)}
    </div>
    ${renderQuickAddBar()}
    <div class="task-list">${tasksHtml}</div>
  </div>`;
}

function renderFilterSelects(tags) {
  const f = state.filters;
  const tagOpts = [{ value: 'all', label: 'כל התגיות' }, ...tags.map(t => ({ value: t, label: t }))];
  return (
    renderCsel('f-status', [
      { value: 'all',         label: 'כל הסטטוסים' },
      { value: 'open',        label: 'פתוח'         },
      { value: 'in-progress', label: 'בביצוע'       },
      { value: 'done',        label: 'הושלם'        },
    ], f.status, "setFilter('status',{val})") +
    renderCsel('f-priority', [
      { value: 'all',    label: 'כל העדיפויות' },
      { value: 'high',   label: 'גבוה'         },
      { value: 'medium', label: 'בינוני'       },
      { value: 'low',    label: 'נמוך'         },
    ], f.priority, "setFilter('priority',{val})") +
    (tags.length ? renderCsel('f-tag', tagOpts, f.tag, "setFilter('tag',{val})") : '')
  );
}

// ============================================================
// TASK CARD
// ============================================================
function renderTaskCard(task, cid, pid, opts) {
  const { showProject, projectName, projectColor, clientName } = opts;
  const at         = state.activeTimer;
  const isRunning  = at && at.taskId === task.id && !at.subtaskId;
  const selected   = state.selectedTaskId === task.id;
  const totalTime  = taskTotalTime(task, cid, pid);
  const baseTime   = isRunning ? (task.timeTotal || 0) : totalTime;
  const overdue    = isOverdue(task.dueDate, task.status);
  const ep         = estimateProgress(totalTime, task.estimatedMinutes);

  const subtasksDone  = (task.subtasks || []).filter(s => s.status === STATUS.DONE).length;
  const subtasksTotal = (task.subtasks || []).length;

  const tickAttrs = isRunning ? `data-tick data-base="${task.timeTotal || 0}"` : '';

  return `<div class="task-card ${selected ? 'selected' : ''} ${task.status === STATUS.DONE ? 'task-done' : ''}"
      onclick="selectTask('${cid}','${pid}','${task.id}')">
    <button class="status-btn status-${task.status}"
      onclick="event.stopPropagation();cycleStatus('${cid}','${pid}','${task.id}')"
      title="${STATUS_LABELS[task.status]}">${task.status === STATUS.DONE ? '✓' : task.status === STATUS.IN_PROGRESS ? '◐' : ''}</button>
    <div class="task-card-body">
      <div class="task-card-row1">
        <span class="task-title ${task.status === STATUS.DONE ? 'done' : ''}">${esc(task.title)}</span>
      </div>
      ${showProject ? `<div class="task-project-label">
        <span class="project-dot sm" style="background:${projectColor}"></span>
        ${esc(clientName)} › ${esc(projectName)}
      </div>` : ''}
      <div class="task-meta">
        <span class="badge badge-${task.priority}">${PRIORITY_LABELS[task.priority] || task.priority}</span>
        ${(task.tags || []).map(t => `<span class="badge badge-tag">${esc(t)}</span>`).join('')}
        ${task.dueDate ? `<span class="badge badge-date ${overdue ? 'overdue' : ''}">${overdue ? '⚠ ' : ''}${formatDisplayDate(task.dueDate)}</span>` : ''}
        ${subtasksTotal > 0 ? `<span class="badge badge-subtasks">${subtasksDone}/${subtasksTotal} תתי-משימות</span>` : ''}
        ${ep?.over ? `<span class="badge badge-over">⚠ חריגה מהתכנון</span>` : ''}
      </div>
    </div>
    <div class="task-card-right">
      <div class="timer-wrap">
        <span class="timer-display ${isRunning ? 'timer-running' : ''}" ${tickAttrs}>${formatTime(baseTime)}</span>
        <button class="timer-btn ${isRunning ? 'running' : ''}"
          onclick="event.stopPropagation();${isRunning ? 'stopTimer()' : `startTimer('${cid}','${pid}','${task.id}')`}"
          title="${isRunning ? 'עצור שעון' : 'הפעל שעון'}">${isRunning ? '⏸' : '▶'}</button>
      </div>
    </div>
  </div>`;
}

// ============================================================
// TASK PANEL
// ============================================================
function renderTaskPanel() {
  const panel = document.getElementById('task-panel');
  if (!panel) return;

  const tid = state.selectedTaskId;
  const cid = state.panelClientId;
  const pid = state.panelProjectId;

  if (!tid || !cid || !pid) { panel.classList.remove('open'); panel.innerHTML = ''; return; }

  const task = getTask(cid, pid, tid);
  if (!task) { panel.classList.remove('open'); panel.innerHTML = ''; return; }

  panel.classList.add('open');
  panel.innerHTML = buildTaskPanel(task, cid, pid);
}

function buildTaskPanel(task, cid, pid) {
  const at        = state.activeTimer;
  const isRunning = at && at.taskId === task.id && !at.subtaskId;
  const total     = taskTotalTime(task, cid, pid);
  const tickAttrs = isRunning ? `data-tick data-base="${task.timeTotal || 0}"` : '';

  const subtasksHtml = (task.subtasks || []).length === 0
    ? `<div class="empty-state sm">אין תתי-משימות</div>`
    : (task.subtasks || []).map(s => buildSubtaskRow(s, cid, pid, task.id)).join('');

  const tagsHtml = (task.tags || []).map(t =>
    `<span class="panel-tag-chip">${esc(t)}<button class="panel-tag-rm" onclick="removePanelTag('${cid}','${pid}','${task.id}','${esc(t)}')">✕</button></span>`
  ).join('') + `<input class="panel-tag-input" placeholder="+ תגית" onkeydown="addPanelTag(event,'${cid}','${pid}','${task.id}')">`;

  const estBar = task.estimatedMinutes ? (() => {
    const ep  = estimateProgress(total, task.estimatedMinutes);
    const pct = Math.min(ep.pct * 100, 100).toFixed(0);
    return `<div class="estimate-bar-wrap" style="margin-top:6px">
      <div class="estimate-bar-track"><div class="estimate-bar-fill ${ep.barState}" style="width:${pct}%"></div></div>
      <span class="estimate-label ${ep.over ? 'text-danger' : ''}">${ep.over ? '⚠ חריגה!' : Math.round(ep.pct*100)+'%'}</span>
    </div>`;
  })() : '';

  return `<div class="panel-inner">
    <div class="panel-header">
      <button class="close-panel-btn" onclick="closeTaskPanel()">✕</button>
      <div class="panel-header-actions">
        <button class="btn btn-ghost btn-sm" onclick="showMoveTaskModal('${cid}','${pid}','${task.id}')">📦 העברה</button>
        <button class="btn btn-ghost btn-sm btn-danger" onclick="confirmDeleteTask('${cid}','${pid}','${task.id}')">🗑️</button>
      </div>
    </div>
    <div class="panel-body">

      <!-- Title -->
      <div class="panel-title-row">
        <button class="status-btn status-${task.status}"
          onclick="cycleStatus('${cid}','${pid}','${task.id}')"
          title="${STATUS_LABELS[task.status]}">${task.status === STATUS.DONE ? '✓' : task.status === STATUS.IN_PROGRESS ? '◐' : ''}</button>
        <input class="panel-title-input ${task.status === STATUS.DONE ? 'done' : ''}"
          value="${esc(task.title)}"
          onblur="saveTaskField('${cid}','${pid}','${task.id}','title',this.value)"
          onkeydown="if(event.key==='Enter')this.blur()">
      </div>

      <!-- Fields grid -->
      <div class="panel-fields">
        <div class="panel-field">
          <label>עדיפות</label>
          ${renderCsel('panel-prio', [
            { value: 'high',   label: '🔴 גבוה'   },
            { value: 'medium', label: '🟡 בינוני' },
            { value: 'low',    label: '🟢 נמוך'   },
          ], task.priority, `saveTaskField('${cid}','${pid}','${task.id}','priority',{val},true)`)}
        </div>
        <div class="panel-field">
          <label>סטטוס</label>
          ${renderCsel('panel-status', [
            { value: 'open',        label: 'פתוח'   },
            { value: 'in-progress', label: 'בביצוע' },
            { value: 'done',        label: 'הושלם'  },
          ], task.status, `saveTaskField('${cid}','${pid}','${task.id}','status',{val},true)`)}
        </div>
        <div class="panel-field">
          <label>תאריך יעד</label>
          <input type="date" class="panel-select" value="${task.dueDate||''}"
            onchange="saveTaskField('${cid}','${pid}','${task.id}','dueDate',this.value||null,true)">
        </div>
        <div class="panel-field">
          <label>משוער (דק')</label>
          <input type="number" class="panel-select" value="${task.estimatedMinutes||''}" min="0" step="15" placeholder="—"
            onblur="saveTaskField('${cid}','${pid}','${task.id}','estimatedMinutes',parseInt(this.value)||null)">
        </div>
      </div>

      <!-- Tags -->
      <div class="panel-field-block">
        <label>תגיות</label>
        <div class="panel-tags-wrap">${tagsHtml}</div>
      </div>

      <!-- Description -->
      <div class="panel-field-block">
        <label>תיאור</label>
        <textarea class="panel-desc" placeholder="תיאור המשימה..."
          onblur="saveTaskField('${cid}','${pid}','${task.id}','description',this.value)"
        >${esc(task.description||'')}</textarea>
      </div>

      <!-- Timer -->
      <div class="panel-timer-row">
        <div style="flex:1">
          <div class="panel-timer-label">זמן מצטבר${task.estimatedMinutes ? ` / משוער: ${formatEstimate(task.estimatedMinutes)}` : ''}</div>
          <div class="panel-timer-value ${isRunning ? 'running' : ''}" ${tickAttrs}>${formatTime(isRunning ? (task.timeTotal||0) : total)}</div>
          ${estBar}
        </div>
        <button class="timer-btn lg ${isRunning ? 'running' : ''}"
          onclick="${isRunning ? 'stopTimer()' : `startTimer('${cid}','${pid}','${task.id}')`}">
          ${isRunning ? '⏸' : '▶'}
        </button>
      </div>

      <!-- Subtasks -->
      <div class="panel-section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <h4 style="margin:0">תתי-משימות</h4>
          <button class="btn btn-ghost btn-sm" onclick="showAddSubtaskModal('${cid}','${pid}','${task.id}')">＋ הוסף</button>
        </div>
        <div class="subtasks-list">${subtasksHtml}</div>
      </div>

    </div>
  </div>`;
}

// Save a single task field without re-rendering the panel (preserves focus)
function saveTaskField(cid, pid, tid, field, value, rerenderPanel = false) {
  updateTask(cid, pid, tid, { [field]: value });
  renderSidebar();
  renderMain();
  if (rerenderPanel) renderTaskPanel();
}

function removePanelTag(cid, pid, tid, tag) {
  const t = getTask(cid, pid, tid); if (!t) return;
  t.tags = (t.tags || []).filter(x => x !== tag);
  saveState(); renderTaskPanel(); renderMain();
}

function addPanelTag(e, cid, pid, tid) {
  if (e.key !== 'Enter' && e.key !== ',') return;
  e.preventDefault();
  const tag = e.target.value.trim();
  if (!tag) return;
  const t = getTask(cid, pid, tid); if (!t) return;
  if (!(t.tags || []).includes(tag)) {
    t.tags = [...(t.tags || []), tag];
    saveState();
  }
  renderTaskPanel(); renderMain();
}

function buildSubtaskRow(sub, cid, pid, tid) {
  const at       = state.activeTimer;
  const isActive = at && at.subtaskId === sub.id;
  const base     = sub.timeTotal || 0;
  const tickAttrs = isActive ? `data-tick data-base="${base}"` : '';

  return `<div class="subtask-item ${sub.status===STATUS.DONE?'done':''}">
    <button class="status-btn sm status-${sub.status}"
      onclick="toggleSubtaskDone('${cid}','${pid}','${tid}','${sub.id}')"
      style="width:18px;height:18px;font-size:9px">${sub.status===STATUS.DONE?'✓':''}</button>
    <div class="subtask-body">
      <div class="subtask-title ${sub.status===STATUS.DONE?'done':''}">${esc(sub.title)}</div>
      ${sub.description ? `<div class="subtask-desc">${esc(sub.description)}</div>` : ''}
    </div>
    <div class="subtask-actions">
      <span class="timer-display ${isActive?'timer-running':''}" style="font-size:11px;min-width:50px" ${tickAttrs}>${formatTime(isActive?base:base)}</span>
      <button class="timer-btn ${isActive?'running':''}" style="width:24px;height:24px;font-size:9px"
        onclick="${isActive?'stopTimer()':`startTimer('${cid}','${pid}','${tid}','${sub.id}')`}">${isActive?'⏸':'▶'}</button>
      <button class="btn-icon" onclick="showEditSubtaskModal('${cid}','${pid}','${tid}','${sub.id}')">✏️</button>
      <button class="btn-icon danger" onclick="confirmDeleteSubtask('${cid}','${pid}','${tid}','${sub.id}')">🗑️</button>
    </div>
  </div>`;
}

// ============================================================
// ACTIVE TIMER INDICATOR (sidebar)
// ============================================================
function renderActiveTimer() {
  const el = document.getElementById('active-timer-indicator');
  if (!el) return;
  const at = state.activeTimer;
  if (!at) { el.innerHTML = ''; return; }

  const task    = getTask(at.clientId, at.projectId, at.taskId);
  const sub     = at.subtaskId ? getSubtask(at.clientId, at.projectId, at.taskId, at.subtaskId) : null;
  const project = getProject(at.clientId, at.projectId);
  const label   = sub ? sub.title : (task?.title || '');
  const base    = (sub ? sub.timeTotal : task?.timeTotal) || 0;

  el.innerHTML = `<div class="active-timer-widget">
    <div class="active-timer-info">
      <div class="active-timer-label">${esc(label)}</div>
      <div class="active-timer-sub">${esc(project?.name || '')}</div>
    </div>
    <div class="active-timer-right">
      <span class="active-timer-time" id="timer-widget-value" data-base="${base}">${formatTime(base + elapsed(at.startTime))}</span>
      <button class="timer-stop-btn" onclick="stopTimer()" title="עצור">⏹</button>
    </div>
  </div>`;
}

// ============================================================
// MODALS — HELPERS
// ============================================================
function showModal(title, bodyHtml, footerHtml) {
  const overlay = document.getElementById('modal-overlay');
  const box     = document.getElementById('modal-box');
  box.innerHTML = `
    <div class="modal-header">
      <h3>${title}</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-footer">${footerHtml}</div>`;
  overlay.classList.remove('hidden');
  setTimeout(() => { const inp = box.querySelector('input,textarea'); if (inp) inp.focus(); }, 60);
}

function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); }
function handleOverlayClick(e) { if (e.target === document.getElementById('modal-overlay')) closeModal(); }

function fval(id) { return document.getElementById(id)?.value?.trim() || ''; }

// ============================================================
// MODAL — ADD / EDIT CLIENT
// ============================================================
function showAddClientModal() {
  showModal('לקוח חדש',
    `<div class="form-group"><label>שם *</label><input id="f-name" placeholder="שם הלקוח"></div>
     <div class="form-group"><label>אימייל</label><input id="f-email" type="email" placeholder="email@example.com"></div>
     <div class="form-group"><label>טלפון</label><input id="f-phone" placeholder="050-0000000"></div>
     <div class="form-group"><label>הערות</label><textarea id="f-notes" rows="3" placeholder="הערות..."></textarea></div>`,
    `<button class="btn btn-primary" onclick="submitAddClient()">הוסף לקוח</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitAddClient() {
  const name = fval('f-name');
  if (!name) { showToast('שם הלקוח חובה', 'error'); return; }
  const c = addClient({ name, email: fval('f-email'), phone: fval('f-phone'), notes: fval('f-notes') });
  closeModal(); selectClient(c.id);
}

function showEditClientModal(cid) {
  const c = getClient(cid); if (!c) return;
  showModal('עריכת לקוח',
    `<div class="form-group"><label>שם *</label><input id="f-name" value="${esc(c.name)}"></div>
     <div class="form-group"><label>אימייל</label><input id="f-email" type="email" value="${esc(c.email||'')}"></div>
     <div class="form-group"><label>טלפון</label><input id="f-phone" value="${esc(c.phone||'')}"></div>
     <div class="form-group"><label>הערות</label><textarea id="f-notes" rows="3">${esc(c.notes||'')}</textarea></div>`,
    `<button class="btn btn-primary" onclick="submitEditClient('${cid}')">שמור</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitEditClient(cid) {
  const name = fval('f-name');
  if (!name) { showToast('שם הלקוח חובה', 'error'); return; }
  updateClient(cid, { name, email: fval('f-email'), phone: fval('f-phone'), notes: fval('f-notes') });
  closeModal(); render();
}

// ============================================================
// MODAL — ADD / EDIT PROJECT
// ============================================================
function showAddProjectModal(cid) {
  showModal('פרויקט חדש', buildProjectForm({}),
    `<button class="btn btn-primary" onclick="submitAddProject('${cid}')">הוסף פרויקט</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitAddProject(cid) {
  const name = fval('f-name');
  if (!name) { showToast('שם הפרויקט חובה', 'error'); return; }
  const color = document.querySelector('input[name="pcolor"]:checked')?.value || PROJECT_COLORS[0];
  const p = addProject(cid, { name, color });
  closeModal(); selectProject(cid, p.id);
}

function showEditProjectModal(cid, pid) {
  const p = getProject(cid, pid); if (!p) return;
  showModal('עריכת פרויקט', buildProjectForm(p),
    `<button class="btn btn-primary" onclick="submitEditProject('${cid}','${pid}')">שמור</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitEditProject(cid, pid) {
  const name = fval('f-name');
  if (!name) { showToast('שם הפרויקט חובה', 'error'); return; }
  const color = document.querySelector('input[name="pcolor"]:checked')?.value || PROJECT_COLORS[0];
  updateProject(cid, pid, { name, color });
  closeModal(); render();
}

function buildProjectForm(p) {
  const swatches = PROJECT_COLORS.map((c, i) =>
    `<label class="color-option" title="${c}">
      <input type="radio" name="pcolor" value="${c}" ${(p.color||PROJECT_COLORS[0])===c?'checked':''}>
      <span class="color-swatch" style="background:${c};color:${c}"></span>
    </label>`
  ).join('');
  return `<div class="form-group"><label>שם *</label><input id="f-name" value="${esc(p.name||'')}" placeholder="שם הפרויקט"></div>
    <div class="form-group"><label>צבע</label><div class="color-picker">${swatches}</div></div>`;
}

// ============================================================
// MODAL — ADD / EDIT TASK
// ============================================================
function showAddTaskModal(cid, pid) {
  showModal('משימה חדשה', buildTaskForm({}),
    `<button class="btn btn-primary" onclick="submitAddTask('${cid}','${pid}')">הוסף משימה</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitAddTask(cid, pid) {
  const title = fval('f-title');
  if (!title) { showToast('כותרת המשימה חובה', 'error'); return; }
  const tags = fval('f-tags') ? fval('f-tags').split(',').map(x=>x.trim()).filter(Boolean) : [];
  const estRaw = parseInt(document.getElementById('f-estimate')?.value || '0', 10);
  const t = addTask(cid, pid, {
    title, description: fval('f-desc'),
    priority: document.getElementById('f-priority')?.value || 'medium',
    dueDate: fval('f-due') || null, tags,
    estimatedMinutes: estRaw > 0 ? estRaw : null
  });
  closeModal(); selectTask(cid, pid, t.id);
}

function showEditTaskModal(cid, pid, tid) {
  const t = getTask(cid, pid, tid); if (!t) return;
  showModal('עריכת משימה', buildTaskForm(t),
    `<button class="btn btn-primary" onclick="submitEditTask('${cid}','${pid}','${tid}')">שמור</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitEditTask(cid, pid, tid) {
  const title = fval('f-title');
  if (!title) { showToast('כותרת המשימה חובה', 'error'); return; }
  const tags = fval('f-tags') ? fval('f-tags').split(',').map(x=>x.trim()).filter(Boolean) : [];
  const estRaw2 = parseInt(document.getElementById('f-estimate')?.value || '0', 10);
  updateTask(cid, pid, tid, {
    title, description: fval('f-desc'),
    priority: document.getElementById('f-priority')?.value || 'medium',
    dueDate: fval('f-due') || null,
    status: document.getElementById('f-status')?.value || 'open',
    estimatedMinutes: estRaw2 > 0 ? estRaw2 : null,
    tags
  });
  closeModal(); render();
}

function buildTaskForm(t) {
  const pSel = (v) => (t.priority||'medium')===v ? 'selected' : '';
  const sSel = (v) => (t.status||'open')===v ? 'selected' : '';
  return `
    <div class="form-group"><label>כותרת *</label><input id="f-title" value="${esc(t.title||'')}" placeholder="כותרת המשימה"></div>
    <div class="form-group"><label>תיאור</label><textarea id="f-desc" rows="4" placeholder="תיאור...">${esc(t.description||'')}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label>עדיפות</label>
        <select id="f-priority">
          <option value="high" ${pSel('high')}>גבוה</option>
          <option value="medium" ${pSel('medium')}>בינוני</option>
          <option value="low" ${pSel('low')}>נמוך</option>
        </select>
      </div>
      <div class="form-group"><label>תאריך יעד</label><input id="f-due" type="date" value="${t.dueDate||''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>זמן משוער (דקות)</label><input id="f-estimate" type="number" min="0" step="15" value="${t.estimatedMinutes||''}" placeholder="למשל: 90"></div>
      <div class="form-group"><label>תגיות (פסיק בין תגיות)</label><input id="f-tags" value="${esc((t.tags||[]).join(', '))}" placeholder="frontend, באג"></div>
    </div>
    ${t.status !== undefined ? `<div class="form-group"><label>סטטוס</label>
      <select id="f-status">
        <option value="open" ${sSel('open')}>פתוח</option>
        <option value="in-progress" ${sSel('in-progress')}>בביצוע</option>
        <option value="done" ${sSel('done')}>הושלם</option>
      </select></div>` : ''}`;
}

// ============================================================
// MODAL — MOVE TASK
// ============================================================
function showMoveTaskModal(cid, pid, tid) {
  const task = getTask(cid, pid, tid); if (!task) return;
  let opts = '';
  for (const c of state.clients) {
    for (const p of (c.projects || [])) {
      if (p.id !== pid) {
        opts += `<option value="${c.id}|${p.id}">${esc(c.name)} › ${esc(p.name)}</option>`;
      }
    }
  }
  if (!opts) { showToast('אין פרויקטים אחרים', 'warning'); return; }

  showModal('העברת משימה',
    `<p style="margin-bottom:12px;font-size:13.5px">העבר את "<strong>${esc(task.title)}</strong>" אל:</p>
     <div class="form-group"><label>פרויקט יעד</label><select id="f-target" style="width:100%">${opts}</select></div>`,
    `<button class="btn btn-primary" onclick="submitMoveTask('${cid}','${pid}','${tid}')">העבר</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitMoveTask(cid, pid, tid) {
  const val = document.getElementById('f-target')?.value;
  if (!val) return;
  const [toCid, toPid] = val.split('|');
  moveTask(tid, cid, pid, toCid, toPid);
  state.selectedClientId = toCid; state.selectedProjectId = toPid;
  state.selectedTaskId = tid; state.panelClientId = toCid; state.panelProjectId = toPid;
  state.currentView = 'project';
  closeModal(); render();
  showToast('משימה הועברה', 'success');
}

// ============================================================
// MODAL — ADD / EDIT SUBTASK
// ============================================================
function showAddSubtaskModal(cid, pid, tid) {
  showModal('תת-משימה חדשה',
    `<div class="form-group"><label>כותרת *</label><input id="f-title" placeholder="כותרת תת-המשימה"></div>
     <div class="form-group"><label>תיאור</label><textarea id="f-desc" rows="3" placeholder="תיאור..."></textarea></div>`,
    `<button class="btn btn-primary" onclick="submitAddSubtask('${cid}','${pid}','${tid}')">הוסף</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitAddSubtask(cid, pid, tid) {
  const title = fval('f-title');
  if (!title) { showToast('כותרת חובה', 'error'); return; }
  addSubtask(cid, pid, tid, { title, description: fval('f-desc') });
  closeModal(); render();
}

function showEditSubtaskModal(cid, pid, tid, sid) {
  const s = getSubtask(cid, pid, tid, sid); if (!s) return;
  showModal('עריכת תת-משימה',
    `<div class="form-group"><label>כותרת *</label><input id="f-title" value="${esc(s.title)}"></div>
     <div class="form-group"><label>תיאור</label><textarea id="f-desc" rows="3">${esc(s.description||'')}</textarea></div>`,
    `<button class="btn btn-primary" onclick="submitEditSubtask('${cid}','${pid}','${tid}','${sid}')">שמור</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitEditSubtask(cid, pid, tid, sid) {
  const title = fval('f-title');
  if (!title) { showToast('כותרת חובה', 'error'); return; }
  updateSubtask(cid, pid, tid, sid, { title, description: fval('f-desc') });
  closeModal(); render();
}

// ============================================================
// MODAL — CONFIRM DELETES
// ============================================================
function confirmDeleteClient(cid) {
  const c = getClient(cid);
  showModal('מחיקת לקוח',
    `<p class="modal-warning">האם למחוק את הלקוח "<strong>${esc(c?.name)}</strong>"?</p>
     <div class="modal-warning-sub">⚠️ כל הפרויקטים והמשימות שלו יימחקו לצמיתות.</div>`,
    `<button class="btn btn-ghost btn-danger" onclick="deleteClient('${cid}');closeModal();render()">מחק</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function confirmDeleteProject(cid, pid) {
  const p = getProject(cid, pid);
  showModal('מחיקת פרויקט',
    `<p class="modal-warning">האם למחוק את הפרויקט "<strong>${esc(p?.name)}</strong>"?</p>
     <div class="modal-warning-sub">⚠️ כל המשימות שלו יימחקו לצמיתות.</div>`,
    `<button class="btn btn-ghost btn-danger" onclick="deleteProject('${cid}','${pid}');closeModal();render()">מחק</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function confirmDeleteTask(cid, pid, tid) {
  const t = getTask(cid, pid, tid);
  showModal('מחיקת משימה',
    `<p class="modal-warning">האם למחוק את המשימה "<strong>${esc(t?.title)}</strong>"?</p>`,
    `<button class="btn btn-ghost btn-danger" onclick="deleteTask('${cid}','${pid}','${tid}');closeModal();render()">מחק</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function confirmDeleteSubtask(cid, pid, tid, sid) {
  const s = getSubtask(cid, pid, tid, sid);
  showModal('מחיקת תת-משימה',
    `<p class="modal-warning">האם למחוק את תת-המשימה "<strong>${esc(s?.title)}</strong>"?</p>`,
    `<button class="btn btn-ghost btn-danger" onclick="deleteSubtask('${cid}','${pid}','${tid}','${sid}');closeModal();render()">מחק</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

// ============================================================
// MODAL — SETTINGS
// ============================================================
function openSettings() {
  showModal('הגדרות',
    `<div class="form-group">
       <label>Clockify API Key</label>
       <input id="f-apikey" value="${esc(state.clockifyApiKey||'')}" placeholder="הדבק כאן את מפתח ה-API שלך">
       <small>המפתח נשמר ב-localStorage בלבד, לא נשלח לשום מקום אחר.</small>
     </div>
     <div class="form-group">
       <label>Workspace ID</label>
       <input value="${CLOCKIFY_WORKSPACE}" readonly>
     </div>`,
    `<button class="btn btn-primary" onclick="saveSettings()">שמור</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function saveSettings() {
  state.clockifyApiKey = fval('f-apikey');
  saveState(); closeModal();
  showToast('הגדרות נשמרו ✓', 'success');
}

// ============================================================
// TOAST
// ============================================================
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => el.classList.add('show')); });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ============================================================
// CUSTOM SELECT (csel) — replaces native <select> to avoid browser flash
// ============================================================

// uid    — unique string id  (DOM id = "csel-{uid}")
// opts   — [{ value, label }]
// curVal — currently selected value
// expr   — JS expression to execute on pick; {val} is substituted with the value
function renderCsel(uid, opts, curVal, expr) {
  const cur = opts.find(o => o.value === curVal) || opts[0];
  const optsHtml = opts.map(o => {
    const safeVal = o.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const call    = expr.replace(/\{val\}/g, `'${safeVal}'`);
    return `<div class="csel-opt${o.value === curVal ? ' sel' : ''}"
      onmousedown="event.preventDefault();${call};cselClose('${uid}')"
    >${esc(o.label)}</div>`;
  }).join('');
  return `<div class="csel" id="csel-${uid}">
    <button type="button" class="csel-btn" onclick="cselToggle(event,'${uid}')">
      <span class="csel-label">${esc(cur ? cur.label : '')}</span>
      <span class="csel-arrow">▾</span>
    </button>
    <div class="csel-drop">${optsHtml}</div>
  </div>`;
}

function cselToggle(e, uid) {
  e.stopPropagation();
  const el = document.getElementById('csel-' + uid);
  const wasOpen = el.classList.contains('open');
  document.querySelectorAll('.csel.open').forEach(c => c.classList.remove('open'));
  if (!wasOpen) el.classList.add('open');
}

function cselClose(uid) {
  document.getElementById('csel-' + uid)?.classList.remove('open');
}

// ============================================================
// KEYBOARD
// ============================================================
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('modal-overlay');
    if (!overlay.classList.contains('hidden')) { closeModal(); return; }
    if (state.selectedTaskId) { closeTaskPanel(); }
  }
});

document.addEventListener('click', () => {
  document.querySelectorAll('.csel.open').forEach(c => c.classList.remove('open'));
});

// ============================================================
// QUICK ADD (Todoist-style)
// ============================================================

// --- Date helpers ---
function _offsetDate(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
function _nextMonth() {
  const d = new Date(); d.setMonth(d.getMonth() + 1);
  return d.toISOString().split('T')[0];
}
function _nextWeekday(target) {
  // Always picks the NEXT future occurrence (never today itself)
  const d = new Date();
  let diff = target - d.getDay();
  if (diff <= 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

// label shown in autocomplete, key used after $ (no spaces)
const DATE_KEYWORDS = [
  { key: 'היום',       label: 'היום',       fn: () => todayStr()      },
  { key: 'מחר',        label: 'מחר',        fn: () => _offsetDate(1)  },
  { key: 'שבועהבא',   label: 'שבוע הבא',   fn: () => _offsetDate(7)  },
  { key: 'חודשהבא',   label: 'חודש הבא',   fn: () => _nextMonth()    },
  { key: 'ראשון',      label: 'ראשון',      fn: () => _nextWeekday(0) },
  { key: 'שני',        label: 'שני',        fn: () => _nextWeekday(1) },
  { key: 'שלישי',      label: 'שלישי',      fn: () => _nextWeekday(2) },
  { key: 'רביעי',      label: 'רביעי',      fn: () => _nextWeekday(3) },
  { key: 'חמישי',      label: 'חמישי',      fn: () => _nextWeekday(4) },
  { key: 'שישי',       label: 'שישי',       fn: () => _nextWeekday(5) },
  { key: 'שבת',        label: 'שבת',        fn: () => _nextWeekday(6) },
];

function parseQuickInput(text) {
  let s = text;

  // #ProjectName
  const projMatch = s.match(/#([^\s@#$]+)/);
  const projectName = projMatch ? projMatch[1] : null;
  if (projMatch) s = s.replace(projMatch[0], '');

  // @Tag — one or more
  const tags = [];
  s = s.replace(/@([^\s@#$]+)/g, (_, tag) => { tags.push(tag); return ''; });

  // Date: $keyword  OR  bare keyword  OR  DD/MM/YY[YY]
  let dueDate   = todayStr();
  let hasDate   = false;
  let dateLabel = '';

  // 1. $keyword (explicit prefix)
  const dollarMatch = s.match(/\$([^\s@#$]+)/);
  if (dollarMatch) {
    const entry = DATE_KEYWORDS.find(e => e.key === dollarMatch[1]);
    if (entry) {
      dueDate = entry.fn(); dateLabel = entry.label; hasDate = true;
      s = s.replace(dollarMatch[0], '');
    }
  }

  // 2. bare keyword — longest key first to avoid partial matches
  if (!hasDate) {
    const sorted = [...DATE_KEYWORDS].sort((a, b) => b.key.length - a.key.length);
    for (const entry of sorted) {
      const idx = s.indexOf(entry.key);
      if (idx === -1) continue;
      const charBefore = s[idx - 1];
      const charAfter  = s[idx + entry.key.length];
      const okBefore = idx === 0 || charBefore === ' ';
      const okAfter  = charAfter === undefined || charAfter === ' ';
      if (okBefore && okAfter) {
        dueDate = entry.fn(); dateLabel = entry.label; hasDate = true;
        s = s.slice(0, idx) + s.slice(idx + entry.key.length);
        break;
      }
    }
  }

  // 3. DD/MM/YY[YY]
  if (!hasDate) {
    const dateMatch = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (dateMatch) {
      const dd = dateMatch[1].padStart(2, '0');
      const mm = dateMatch[2].padStart(2, '0');
      const yy = dateMatch[3].length === 2 ? '20' + dateMatch[3] : dateMatch[3];
      dueDate   = `${yy}-${mm}-${dd}`;
      dateLabel = dateMatch[0];
      hasDate   = true;
      s         = s.replace(dateMatch[0], '');
    }
  }

  const title = s.replace(/\s+/g, ' ').trim();
  return { title, projectName, tags, dueDate, hasDate, dateLabel };
}

function findProjectByName(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  // exact match first
  for (const c of state.clients)
    for (const p of (c.projects || []))
      if (p.name.toLowerCase() === lower) return { cid: c.id, pid: p.id, name: p.name, clientName: c.name };
  // starts-with
  for (const c of state.clients)
    for (const p of (c.projects || []))
      if (p.name.toLowerCase().startsWith(lower)) return { cid: c.id, pid: p.id, name: p.name, clientName: c.name };
  // contains
  for (const c of state.clients)
    for (const p of (c.projects || []))
      if (p.name.toLowerCase().includes(lower)) return { cid: c.id, pid: p.id, name: p.name, clientName: c.name };
  return null;
}

function renderQuickAddBar() {
  return `<div class="quick-add-wrap">
    <div class="quick-add-bar">
      <span class="quick-add-icon">＋</span>
      <input class="quick-add-input" id="quick-add-input"
        placeholder="הוסף משימה... #פרויקט @תגית $מחר / $שני / 25/12/26"
        onkeydown="quickAddKeydown(event)"
        oninput="quickAddInput()"
        autocomplete="off" spellcheck="false">
    </div>
    <div class="quick-add-preview" id="quick-add-preview"></div>
    <div class="quick-suggestions" id="quick-suggestions"></div>
  </div>`;
}

function quickAddInput() {
  const input = document.getElementById('quick-add-input');
  if (!input) return;
  updateQuickPreview(input.value);
  updateQuickSuggestions(input);
}

function updateQuickPreview(text) {
  const preview = document.getElementById('quick-add-preview');
  if (!preview) return;
  if (!text.trim()) { preview.innerHTML = ''; return; }

  const { title, projectName, tags, dueDate, hasDate } = parseQuickInput(text);
  const proj = projectName ? findProjectByName(projectName) : null;

  // In project view, show implicit project if no # given
  let implicitProject = null;
  if (!projectName && state.currentView === 'project' && state.selectedClientId && state.selectedProjectId) {
    const p = getProject(state.selectedClientId, state.selectedProjectId);
    const c = getClient(state.selectedClientId);
    if (p && c) implicitProject = { name: p.name, clientName: c.name };
  }

  let chips = '';
  if (projectName) {
    chips += `<span class="qchip ${proj ? 'qchip-ok' : 'qchip-err'}">📁 ${esc(proj ? `${proj.clientName} › ${proj.name}` : projectName)}${proj ? '' : ' ✗'}</span>`;
  } else if (implicitProject) {
    chips += `<span class="qchip qchip-ok">📁 ${esc(implicitProject.clientName)} › ${esc(implicitProject.name)}</span>`;
  }
  tags.forEach(t => { chips += `<span class="qchip qchip-tag">🏷 ${esc(t)}</span>`; });
  const dateDisplay = hasDate
    ? (dateLabel && isNaN(dateLabel[0])
        ? `${esc(dateLabel)} · ${formatDisplayDate(dueDate)}`
        : formatDisplayDate(dueDate))
    : `${formatDisplayDate(dueDate)} (היום)`;
  chips += `<span class="qchip qchip-date">📅 ${dateDisplay}</span>`;
  if (title) chips += `<span class="qchip qchip-title">${esc(title)}</span>`;

  preview.innerHTML = chips;
}

function getActiveToken(input) {
  const val = input.value;
  const pos = input.selectionStart;
  const before = val.slice(0, pos);
  const m = before.match(/([#@$])([^\s#@$]*)$/);
  if (!m) return null;
  return { type: m[1], query: m[2], start: pos - m[0].length };
}

function updateQuickSuggestions(input) {
  const box = document.getElementById('quick-suggestions');
  if (!box) return;
  const token = getActiveToken(input);
  if (!token) { box.innerHTML = ''; box.classList.remove('open'); return; }

  let items = [];
  if (token.type === '#') {
    const q = token.query.toLowerCase();
    for (const c of state.clients)
      for (const p of (c.projects || []))
        if (!q || p.name.toLowerCase().includes(q))
          items.push({ label: `${c.name} › ${p.name}`, value: p.name });
  } else if (token.type === '@') {
    const q = token.query.toLowerCase();
    items = allGlobalTags()
      .filter(t => !q || t.toLowerCase().includes(q))
      .map(t => ({ label: t, value: t }));
  } else { // $
    const q = token.query;
    items = DATE_KEYWORDS
      .filter(e => !q || e.key.startsWith(q) || e.label.startsWith(q))
      .map(e => ({ label: `${e.label}  ·  ${formatDisplayDate(e.fn())}`, value: e.key }));
  }

  if (!items.length) { box.innerHTML = ''; box.classList.remove('open'); return; }

  const highlight = (str, q) => {
    if (!q) return esc(str);
    const idx = str.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return esc(str);
    return esc(str.slice(0, idx)) + '<b>' + esc(str.slice(idx, idx + q.length)) + '</b>' + esc(str.slice(idx + q.length));
  };

  box.innerHTML = items.slice(0, 7).map(it =>
    `<div class="qsugg-item"
       onmousedown="event.preventDefault();applyQuickSuggestion('${esc(it.value)}','${token.type}')"
     >${token.type}${highlight(it.label, token.query)}</div>`
  ).join('');
  box.classList.add('open');
}

function applyQuickSuggestion(value, type) {
  const input = document.getElementById('quick-add-input');
  if (!input) return;
  const token = getActiveToken(input);
  if (!token) return;
  const before = input.value.slice(0, token.start);
  const after  = input.value.slice(input.selectionStart);
  const replacement = type + value + ' ';
  input.value = before + replacement + after;
  input.focus();
  const newPos = token.start + replacement.length;
  input.setSelectionRange(newPos, newPos);
  document.getElementById('quick-suggestions')?.classList.remove('open');
  updateQuickPreview(input.value);
}

function quickAddKeydown(e) {
  const box = document.getElementById('quick-suggestions');
  const isOpen = box?.classList.contains('open');

  if (e.key === 'Enter') {
    e.preventDefault();
    if (isOpen) {
      // Select the first (highlighted) suggestion instead of submitting
      const first = box.querySelector('.qsugg-item');
      if (first) first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } else {
      submitQuickTask();
    }
  } else if (e.key === 'Escape') {
    if (isOpen) {
      box.classList.remove('open');
    } else {
      const input = document.getElementById('quick-add-input');
      if (input) { input.value = ''; updateQuickPreview(''); }
    }
  }
}

// ============================================================
// ASSIGN PROJECT TO CLIENT
// ============================================================
function showAssignClientModal(fromCid, pid) {
  const p = getProject(fromCid, pid); if (!p) return;
  const opts = state.clients
    .filter(c => !c._inbox)
    .map(c => `<option value="${c.id}">${esc(c.name)}</option>`)
    .join('');

  if (!opts) {
    showToast('אין לקוחות — צור לקוח קודם', 'warning'); return;
  }

  showModal('שיוך פרויקט ללקוח',
    `<p style="margin-bottom:12px;font-size:13px;color:var(--text-muted)">שייך את "<strong>${esc(p.name)}</strong>" ללקוח:</p>
     <div class="form-group">
       <label>לקוח</label>
       <select id="f-assign-client">${opts}</select>
     </div>`,
    `<button class="btn btn-primary" onclick="assignProjectToClient('${fromCid}','${pid}')">שייך</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function assignProjectToClient(fromCid, pid) {
  const toCid = document.getElementById('f-assign-client')?.value;
  if (!toCid) return;
  const fromClient = getClient(fromCid);
  const toClient   = getClient(toCid);
  if (!fromClient || !toClient) return;

  const idx = (fromClient.projects || []).findIndex(p => p.id === pid);
  if (idx === -1) return;
  const [proj] = fromClient.projects.splice(idx, 1);
  (toClient.projects = toClient.projects || []).push(proj);

  // Fix active timer if needed
  const at = state.activeTimer;
  if (at?.projectId === pid) at.clientId = toCid;

  // Fix selected state
  if (state.selectedProjectId === pid) state.selectedClientId = toCid;
  if (state.panelProjectId === pid) state.panelClientId = toCid;

  // Clean up inbox client if empty
  if (fromClient._inbox && !(fromClient.projects || []).length) {
    state.clients = state.clients.filter(c => c.id !== fromCid);
    if (state.selectedClientId === fromCid) {
      state.selectedClientId = toCid; state.currentView = 'project';
    }
  }

  saveState(); closeModal(); render();
  showToast(`פרויקט שויך ל-${toClient.name} ✓`, 'success');
}

// Returns or creates the special "ללא לקוח" holding client
function getOrCreateInboxClient() {
  const INBOX_NAME = 'ללא לקוח';
  let c = state.clients.find(cl => cl._inbox);
  if (!c) c = state.clients.find(cl => cl.name === INBOX_NAME);
  if (!c) {
    c = { id: uuid(), name: INBOX_NAME, email: '', phone: '', notes: '', projects: [], _inbox: true };
    state.clients.push(c);
    saveState();
  }
  return c;
}

function showQuickProjectModal(taskTitle, tags, dueDate, suggestedName) {
  const tagsJson = JSON.stringify(tags);

  // All existing projects as options
  const existingOpts = [];
  for (const c of state.clients)
    for (const p of (c.projects || []))
      existingOpts.push(`<option value="${c.id}|${p.id}">${esc(c.name)} › ${esc(p.name)}</option>`);
  const hasExisting = existingOpts.length > 0;

  // Existing clients for new-project assignment
  const clientOpts = state.clients
    .filter(c => !c._inbox)
    .map(c => `<option value="${c.id}">${esc(c.name)}</option>`)
    .join('');

  const colorSwatches = PROJECT_COLORS.map((col, i) =>
    `<label class="color-option"><input type="radio" name="qpcolor" value="${col}" ${i === 0 ? 'checked' : ''}>
     <span class="color-swatch" style="background:${col};color:${col}"></span></label>`
  ).join('');

  const body = `
    ${suggestedName ? `<p style="margin-bottom:12px;font-size:13px;color:var(--text-muted)">הפרויקט "<strong>${esc(suggestedName)}</strong>" לא נמצא</p>` : ''}

    <div class="qtabs">
      ${hasExisting ? `<button class="qtab active" data-tab="existing" onclick="switchQTab('existing')">📂 פרויקט קיים</button>` : ''}
      <button class="qtab ${hasExisting ? '' : 'active'}" data-tab="new" onclick="switchQTab('new')">＋ פרויקט חדש</button>
    </div>

    ${hasExisting ? `<div id="qtab-existing" style="padding-top:14px">
      <div class="form-group">
        <label>בחר פרויקט</label>
        <select id="f-existing-proj">${existingOpts.join('')}</select>
      </div>
    </div>` : ''}

    <div id="qtab-new" style="padding-top:14px;${hasExisting ? 'display:none' : ''}">
      <div class="form-group">
        <label>שם הפרויקט *</label>
        <input id="f-qp-name" value="${esc(suggestedName || '')}" placeholder="שם הפרויקט">
      </div>
      <div class="form-group">
        <label>צבע</label>
        <div class="color-picker">${colorSwatches}</div>
      </div>
      <div class="form-group">
        <label>שיוך ללקוח</label>
        <div class="qclient-opts">
          <button type="button" class="qclient-opt active" data-mode="none"   onclick="switchQClient('none')">ללא לקוח</button>
          ${clientOpts ? `<button type="button" class="qclient-opt" data-mode="existing" onclick="switchQClient('existing')">לקוח קיים</button>` : ''}
          <button type="button" class="qclient-opt" data-mode="new" onclick="switchQClient('new')">+ לקוח חדש</button>
        </div>
        ${clientOpts ? `<select id="f-qclient-sel" style="display:none;margin-top:8px;width:100%">${clientOpts}</select>` : ''}
        <input id="f-qclient-new" placeholder="שם הלקוח החדש" style="display:none;margin-top:8px">
      </div>
    </div>`;

  showModal('משימה ← פרויקט', body,
    `<button class="btn btn-primary" onclick="submitQuickProjectChoice('${esc(taskTitle)}','${esc(tagsJson)}','${esc(dueDate)}')">הוסף משימה</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function switchQTab(mode) {
  document.querySelectorAll('.qtab').forEach(t => t.classList.toggle('active', t.dataset.tab === mode));
  const el = document.getElementById('qtab-existing');
  if (el) el.style.display = mode === 'existing' ? '' : 'none';
  document.getElementById('qtab-new').style.display = mode === 'new' ? '' : 'none';
}

function switchQClient(mode) {
  document.querySelectorAll('.qclient-opt').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const sel = document.getElementById('f-qclient-sel');
  const inp = document.getElementById('f-qclient-new');
  if (sel) sel.style.display = mode === 'existing' ? '' : 'none';
  if (inp) inp.style.display = mode === 'new' ? '' : 'none';
}

function submitQuickProjectChoice(taskTitle, tagsJson, dueDate) {
  const tags = JSON.parse(tagsJson || '[]');

  const existingTab = document.getElementById('qtab-existing');
  const useExisting = existingTab && existingTab.style.display !== 'none';

  if (useExisting) {
    const val = document.getElementById('f-existing-proj')?.value;
    if (!val) { showToast('בחר פרויקט', 'error'); return; }
    const [cid, pid] = val.split('|');
    addTask(cid, pid, { title: taskTitle, tags, dueDate });
    _quickAddDone(cid, pid, 'משימה נוספה ✓');
  } else {
    const projName = document.getElementById('f-qp-name')?.value?.trim();
    if (!projName) { showToast('שם הפרויקט חובה', 'error'); return; }
    const color = document.querySelector('input[name="qpcolor"]:checked')?.value || PROJECT_COLORS[0];
    const clientMode = document.querySelector('.qclient-opt.active')?.dataset.mode || 'none';

    let cid;
    if (clientMode === 'existing') {
      cid = document.getElementById('f-qclient-sel')?.value;
    } else if (clientMode === 'new') {
      const newName = document.getElementById('f-qclient-new')?.value?.trim();
      if (!newName) { showToast('שם הלקוח חובה', 'error'); return; }
      cid = addClient({ name: newName }).id;
    } else {
      cid = getOrCreateInboxClient().id;
    }

    const p = addProject(cid, { name: projName, color });
    addTask(cid, p.id, { title: taskTitle, tags, dueDate });
    _quickAddDone(cid, p.id, 'פרויקט ומשימה נוצרו ✓');
  }
}

function _quickAddDone(cid, pid, msg) {
  closeModal();
  const inp = document.getElementById('quick-add-input');
  if (inp) inp.value = '';
  const prev = document.getElementById('quick-add-preview');
  if (prev) prev.innerHTML = '';
  state.selectedClientId = cid; state.selectedProjectId = pid;
  state.currentView = 'project'; state.filters.status = 'all';
  saveState(); render();
  showToast(msg, 'success');
  setTimeout(() => document.getElementById('quick-add-input')?.focus(), 50);
}

function submitQuickTask() {
  const input = document.getElementById('quick-add-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const { title, projectName, tags, dueDate } = parseQuickInput(text);
  if (!title) { showToast('חסרה כותרת למשימה', 'error'); return; }

  let cid, pid;
  if (projectName) {
    const found = findProjectByName(projectName);
    if (!found) {
      // Project not found — offer to create it
      showQuickProjectModal(title, tags, dueDate, projectName);
      return;
    }
    cid = found.cid; pid = found.pid;
  } else if (state.currentView === 'project' && state.selectedClientId && state.selectedProjectId) {
    cid = state.selectedClientId; pid = state.selectedProjectId;
  } else {
    // No project context — offer to create one
    showQuickProjectModal(title, tags, dueDate, '');
    return;
  }

  addTask(cid, pid, { title, tags, dueDate });
  input.value = '';
  document.getElementById('quick-add-preview').innerHTML = '';
  document.getElementById('quick-suggestions')?.classList.remove('open');

  // Navigate to show the new task
  if (state.currentView !== 'project' || state.selectedProjectId !== pid) {
    state.selectedClientId = cid;
    state.selectedProjectId = pid;
    state.currentView = 'project';
    state.filters.status = 'all';
    saveState();
  }
  render();
  showToast('משימה נוספה ✓', 'success');
  setTimeout(() => document.getElementById('quick-add-input')?.focus(), 50);
}

// ============================================================
// INIT
// ============================================================
function init() {
  loadState();
  render();
  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.quick-add-wrap')) {
      document.getElementById('quick-suggestions')?.classList.remove('open');
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
