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

// ============================================================
// SUPABASE
// ============================================================
const SUPABASE_URL      = 'https://szjlcnprjwlnntlryqpz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6amxjbnByandsbm50bHJ5cXB6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTQzODksImV4cCI6MjA4OTE3MDM4OX0.CLXsRmfDjqIKcSWoSBRGIST5OFtocVp_tQqSBhUBN2I';
const SUPABASE_STATE_ID = 'default';
let _supabase = null;

function initSupabase() {
  try {
    if (typeof window.supabase !== 'undefined' && window.supabase.createClient) {
      _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
  } catch(e) {
    console.warn('Supabase init failed:', e);
  }
}

let _saveSupabaseTimer = null;
function saveToSupabase() {
  if (!_supabase) return;
  clearTimeout(_saveSupabaseTimer);
  _saveSupabaseTimer = setTimeout(async () => {
    try {
      await _supabase.from('app_state').upsert({
        id: SUPABASE_STATE_ID,
        data: state,
        updated_at: new Date().toISOString()
      });
    } catch(e) {
      console.warn('Supabase save failed:', e);
    }
  }, 1000);
}

async function syncFromSupabase() {
  if (!_supabase) return;
  try {
    const { data, error } = await _supabase
      .from('app_state')
      .select('data')
      .eq('id', SUPABASE_STATE_ID)
      .single();
    if (error || !data || !data.data) return;
    const remote = data.data;
    const def = defaultState();
    state = Object.assign(def, remote);
    try { state.business = Object.assign(def.business, remote.business || {}); } catch(e) {}
    try {
      const si = remote.integrations || {};
      const di = def.integrations   || {};
      state.integrations            = Object.assign(di, si);
      state.integrations.clockify   = Object.assign({}, di.clockify   || {}, si.clockify   || {});
      state.integrations.greenapi   = Object.assign({}, di.greenapi   || {}, si.greenapi   || {});
      state.integrations.accounting = Object.assign({}, di.accounting || {}, si.accounting || {});
      state.integrations.claude     = Object.assign({}, { apiKey: '' },      si.claude     || {});
    } catch(e) { state.integrations = def.integrations; }
    if (!state.clients) state.clients = remote.clients || [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
  } catch(e) {
    console.warn('Supabase sync failed:', e);
  }
}

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
let panelActiveTab = 'details'; // 'details' | 'log'
let bulkMode = false;
let bulkSelected = []; // [{cid, pid, tid}]
let bulkVisibleItems = []; // [{cid, pid, tid}] — updated each render
let _aiTaskDescription = null; // set by quickAddWithAI before modal

function defaultState() {
  return {
    clients: [],
    activeTimer: null,
    clockifyApiKey: 'ZjI3MmYxOTUtOTUxOS00MTgyLTgzNzktZDdmNjYzM2UwMmQ5',
    currentView: 'today',
    selectedClientId: null,
    selectedProjectId: null,
    selectedTaskId: null,
    panelClientId: null,
    panelProjectId: null,
    reportRange: null,
    settingsSection: 'business',
    business: {
      name: '', tagline: '', email: '', phone: '',
      address: '', taxId: '', website: '', logoUrl: ''
    },
    integrations: {
      clockify:  { enabled: true,  apiKey: '', workspaceId: CLOCKIFY_WORKSPACE, userId: CLOCKIFY_USER_ID },
      greenapi:  { enabled: false, instanceId: '', token: '' },
      accounting:{ enabled: false, provider: '', apiKey: '' },
      claude:    { apiKey: '' },
    },
    filters: {
      status: STATUS.OPEN,
      priority: 'all',
      tag: 'all',
      clientId: 'all',
      sortBy: 'manual'
    }
  };
}

function loadState() {
  const BACKUP_KEY = STORAGE_KEY + '_backup';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) { state = defaultState(); return; }

    const saved = JSON.parse(raw);

    // Always save a backup before any processing (overwrite only if clients exist)
    if (saved.clients && saved.clients.length > 0) {
      localStorage.setItem(BACKUP_KEY, raw);
    }

    const def = defaultState();
    state = Object.assign(def, saved);

    // Deep-merge nested objects — each wrapped in its own try so one failure can't wipe all data
    try { state.business = Object.assign(def.business, saved.business || {}); } catch(e) {}
    try {
      const si = saved.integrations || {};
      const di = def.integrations   || {};
      state.integrations            = Object.assign(di, si);
      state.integrations.clockify   = Object.assign({}, di.clockify   || {}, si.clockify   || {});
      state.integrations.greenapi   = Object.assign({}, di.greenapi   || {}, si.greenapi   || {});
      state.integrations.accounting = Object.assign({}, di.accounting || {}, si.accounting || {});
      state.integrations.claude     = Object.assign({}, { apiKey: '' },      si.claude     || {});
    } catch(e) { state.integrations = def.integrations; }

    // Ensure clients are always preserved
    if (!state.clients) state.clients = saved.clients || [];

    // Migrate old top-level clockifyApiKey → integrations.clockify.apiKey
    if (saved.clockifyApiKey && !state.integrations.clockify.apiKey) {
      state.integrations.clockify.apiKey = saved.clockifyApiKey;
    }
    if (!state.clockifyApiKey) state.clockifyApiKey = def.clockifyApiKey;

    // Migrate old reportMonth → reportRange
    if (state.reportMonth && !state.reportRange) {
      try {
        const [y, m] = state.reportMonth.split('-').map(Number);
        const from = `${y}-${String(m).padStart(2,'0')}-01`;
        const to   = new Date(y, m, 0).toISOString().split('T')[0];
        state.reportRange = { mode: 'monthly', from, to };
        delete state.reportMonth;
      } catch(e) {}
    }

    // Migrate stored 'in-progress' → 'open'
    for (const c of (state.clients || [])) {
      for (const p of (c.projects || [])) {
        for (const t of (p.tasks || [])) {
          if (t.status === STATUS.IN_PROGRESS) t.status = STATUS.OPEN;
        }
      }
    }

    // Migrate: clear old clockify shared report IDs
    if (!state._clockifyReportV2) {
      for (const c of (state.clients || [])) {
        delete c.clockifySharedReportId;
        for (const p of (c.projects || [])) { delete p.clockifySharedReportId; }
      }
      state._clockifyReportV2 = true;
    }

  } catch (e) {
    console.error('loadState failed, attempting backup restore:', e);
    // Try to restore from backup before giving up
    try {
      const backup = localStorage.getItem(BACKUP_KEY);
      if (backup) {
        const saved = JSON.parse(backup);
        state = Object.assign(defaultState(), saved);
        state.clients = saved.clients || [];
        console.warn('Restored from backup. Clients:', state.clients.length);
        return;
      }
    } catch(e2) {}
    state = defaultState();
  }
}

function recoverFromBackup() {
  const BACKUP_KEY = STORAGE_KEY + '_backup';
  const backup = localStorage.getItem(BACKUP_KEY);
  if (!backup) { showToast('לא נמצא גיבוי', 'error'); return; }
  try {
    const saved = JSON.parse(backup);
    if (!saved.clients || saved.clients.length === 0) { showToast('הגיבוי ריק', 'error'); return; }
    localStorage.setItem(STORAGE_KEY, backup);
    loadState();
    render();
    showToast(`שוחזרו ${saved.clients.length} לקוחות מגיבוי ✓`, 'success');
  } catch(e) {
    showToast('שגיאה בשחזור גיבוי', 'error');
  }
}

function saveState() {
  const data = JSON.stringify(state);
  localStorage.setItem(STORAGE_KEY, data);
  // Always keep a rolling backup — saved only when there is real data
  if (state.clients && state.clients.length > 0) {
    localStorage.setItem(STORAGE_KEY + '_backup', data);
  }
  saveToSupabase();
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

function calcBilling(secs, hourlyRate) {
  if (!hourlyRate || hourlyRate <= 0 || secs <= 0) return null;
  return (secs / 3600) * hourlyRate;
}
function formatMoney(amount) {
  if (amount === null || amount === undefined) return '';
  return '₪' + amount.toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
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

function linkify(text) {
  if (!text) return '';
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      return `<a href="${esc(part)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(part)}</a>`;
    }
    return esc(part).replace(/\n/g, '<br>');
  }).join('');
}

// ============================================================
// DATA HELPERS
// ============================================================
// Derived status: a task is 'in-progress' if it has logged time but isn't done
function effectiveStatus(task) {
  if (!task) return STATUS.OPEN;
  if (task.status === STATUS.DONE) return STATUS.DONE;
  if ((task.timeTotal || 0) > 0) return STATUS.IN_PROGRESS;
  return STATUS.OPEN;
}

function getClient(id) { return state.clients.find(c => c.id === id); }
function getProject(cid, pid) { return getClient(cid)?.projects?.find(p => p.id === pid); }
function getTask(cid, pid, tid) { return getProject(cid, pid)?.tasks?.find(t => t.id === tid); }
function getSubtask(cid, pid, tid, sid) { return getTask(cid, pid, tid)?.subtasks?.find(s => s.id === sid); }

function allTodayItems() {
  const today = todayStr();
  const result = [];
  for (const client of state.clients) {
    if (client.archived) continue;
    for (const project of (client.projects || [])) {
      if (project.archived) continue;
      for (const task of (project.tasks || [])) {
        if (task.status === STATUS.DONE) continue;
        const isToday      = task.dueDate === today;
        const isOverdue    = task.dueDate && task.dueDate < today;
        const isInProgress = effectiveStatus(task) === STATUS.IN_PROGRESS;
        if (isToday || isOverdue || isInProgress) result.push({ client, project, task });
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
  const client = { id: uuid(), name: data.name || 'לקוח חדש', email: data.email || '', phone: data.phone || '', notes: data.notes || '', defaultHourlyRate: data.defaultHourlyRate || 0, clockifyId: null, projects: [] };
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
  const p = { id: uuid(), name: data.name || 'פרויקט חדש', color: data.color || PROJECT_COLORS[0], billable: data.billable || false, hourlyRate: data.hourlyRate || 0, clockifyId: null, tasks: [] };
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

function archiveClient(cid) {
  const c = getClient(cid);
  if (!c) return;
  c.archived = true;
  if (state.activeTimer?.clientId === cid) cancelTimer();
  if (state.selectedClientId === cid) {
    state.selectedClientId = null; state.selectedProjectId = null;
    state.selectedTaskId = null; state.currentView = 'today';
  }
  saveState(); render();
}

function unarchiveClient(cid) {
  const c = getClient(cid);
  if (c) { c.archived = false; saveState(); render(); }
}

function archiveProject(cid, pid) {
  const p = getProject(cid, pid);
  if (!p) return;
  p.archived = true;
  if (state.activeTimer?.projectId === pid) cancelTimer();
  if (state.selectedProjectId === pid) {
    state.selectedProjectId = null; state.selectedTaskId = null; state.currentView = 'client';
  }
  saveState(); render();
}

function unarchiveProject(cid, pid) {
  const p = getProject(cid, pid);
  if (p) { p.archived = false; saveState(); render(); }
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
    estimatedMinutes: data.estimatedMinutes || null,
    recurring: data.recurring || null   // { frequency: 'daily'|'weekly'|'monthly'|'custom', interval: N }

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

function reorderTask(fromTaskId, fromCid, fromPid, toTaskId, insertBefore) {
  if (fromTaskId === toTaskId) return;
  const proj = getProject(fromCid, fromPid);
  if (!proj) return;
  const tasks   = proj.tasks;
  const fromIdx = tasks.findIndex(t => t.id === fromTaskId);
  const toIdx   = tasks.findIndex(t => t.id === toTaskId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [task] = tasks.splice(fromIdx, 1);
  const newIdx  = tasks.findIndex(t => t.id === toTaskId);
  tasks.splice(insertBefore ? newIdx : newIdx + 1, 0, task);
  saveState();
  render();
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
      clientId:    cid,
      projectId:   pid,
      taskName:    s ? s.title : (t?.title || ''),
      taskId:      s ? null : tid,
      description: s ? (s.description || '') : (t?.description || ''),
      billable:    p?.billable || false,
      startTime
    }).then(entryId => {
      if (entryId && state.activeTimer) {
        state.activeTimer.clockifyEntryId = entryId;
        saveState();
      }
    });
  }
}

function startProjectPlanningTimer(cid, pid) {
  if (state.activeTimer) stopTimer();

  const startTime = Date.now();
  state.activeTimer = {
    type: 'planning',
    clientId: cid, projectId: pid, taskId: null, subtaskId: null,
    startTime,
    clockifyEntryId: null
  };
  saveState();
  startTimerTick();
  render();

  if (state.clockifyApiKey) {
    const c = getClient(cid);
    const p = getProject(cid, pid);
    clockifyStartEntry({
      clientName:  c?.name || '',
      projectName: p?.name || '',
      clientId:    cid,
      projectId:   pid,
      taskName:    'אפיון ותכנון',
      description: '',
      billable:    p?.billable || false,
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

  // Accumulate time locally (not for planning timers — no task)
  if (at.type !== 'planning') {
    const timeEntry = {
      id: uuid(),
      date:    new Date(endTime).toISOString().split('T')[0],
      start:   at.startTime,
      end:     endTime,
      seconds: secs
    };
    if (at.type === 'subtask') {
      const s = getSubtask(at.clientId, at.projectId, at.taskId, at.subtaskId);
      if (s) { s.timeTotal = (s.timeTotal || 0) + secs; (s.timeEntries = s.timeEntries || []).push(timeEntry); }
    } else {
      const t = getTask(at.clientId, at.projectId, at.taskId);
      if (t) { t.timeTotal = (t.timeTotal || 0) + secs; (t.timeEntries = t.timeEntries || []).push(timeEntry); }
    }
  }

  // Stop Clockify entry
  if (state.clockifyApiKey) {
    if (at.clockifyEntryId) {
      clockifyStopEntry(at.clockifyEntryId, endTime);
    } else {
      const c = getClient(at.clientId);
      const p = getProject(at.clientId, at.projectId);
      if (at.type === 'planning') {
        clockifyCreateEntry({
          clientName: c?.name || '', projectName: p?.name || '',
          clientId: at.clientId, projectId: at.projectId,
          taskName: 'אפיון ותכנון', description: '',
          billable: p?.billable || false, start: at.startTime, end: endTime
        });
      } else {
        const t = getTask(at.clientId, at.projectId, at.taskId);
        const s = at.subtaskId ? getSubtask(at.clientId, at.projectId, at.taskId, at.subtaskId) : null;
        clockifyCreateEntry({
          clientName:  c?.name || '', projectName: p?.name || '',
          clientId:    at.clientId, projectId:   at.projectId,
          taskName:    s ? s.title : (t?.title || ''),
          taskId:      s ? null : at.taskId,
          description: s ? (s.description || '') : (t?.description || ''),
          billable:    p?.billable || false, start: at.startTime, end: endTime
        });
      }
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

// Shared: resolve projectId + taskId (find or create client / project / task)
async function clockifyResolveProject(apiKey, wsId, clientName, projectName, localClientId, localProjectId, taskName, localTaskId) {
  let clockifyClientId  = clientName  ? await clockifyUpsertClient(apiKey, wsId, clientName, localClientId)  : null;
  let clockifyProjectId = projectName ? await clockifyUpsertProject(apiKey, wsId, projectName, clockifyClientId, localClientId, localProjectId) : null;
  if (!clockifyProjectId) throw new Error(`לא ניתן למצוא/ליצור פרויקט "${projectName}" ב-Clockify`);
  let clockifyTaskId = taskName && clockifyProjectId
    ? await clockifyUpsertTask(apiKey, wsId, clockifyProjectId, taskName, localClientId, localProjectId, localTaskId)
    : null;
  return { projectId: clockifyProjectId, taskId: clockifyTaskId };
}

// Called on ▶ — opens a live running entry, returns entry ID
async function clockifyStartEntry({ clientName, projectName, clientId, projectId: localProjectId, taskName, taskId: localTaskId, description, billable, startTime }) {
  const apiKey = state.clockifyApiKey;
  const wsId   = CLOCKIFY_WORKSPACE;
  try {
    const { projectId, taskId } = await clockifyResolveProject(apiKey, wsId, clientName, projectName, clientId, localProjectId, taskName, localTaskId);
    const body = {
      start: new Date(startTime).toISOString(),
      description: description || '',
      projectId,
      billable: billable || false
    };
    if (taskId) body.taskId = taskId;
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
async function clockifyCreateEntry({ clientName, projectName, clientId, projectId: localProjectId, taskName, taskId: localTaskId, description, billable, start, end }) {
  const apiKey = state.clockifyApiKey;
  const wsId   = CLOCKIFY_WORKSPACE;
  try {
    const { projectId, taskId } = await clockifyResolveProject(apiKey, wsId, clientName, projectName, clientId, localProjectId, taskName, localTaskId);
    const body = {
      start: new Date(start).toISOString(),
      end:   new Date(end).toISOString(),
      description: description || '',
      projectId,
      billable: billable || false
    };
    if (taskId) body.taskId = taskId;
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

async function clockifyUpsertClient(apiKey, wsId, name, localClientId) {
  // Use cached Clockify ID if available — avoids lookup by name entirely
  if (localClientId) {
    const localClient = getClient(localClientId);
    if (localClient?.clockifyId) return localClient.clockifyId;
  }
  try {
    let id = null;
    const r = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/clients?name=${encodeURIComponent(name)}&page-size=50`, { headers: { 'X-Api-Key': apiKey } });
    if (r.ok) {
      const list = await r.json();
      const found = list.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (found) id = found.id;
    }
    if (!id) {
      const cr = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/clients`, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (cr.ok) { const x = await cr.json(); id = x.id; }
      else console.warn('Clockify create client failed:', cr.status, await cr.text());
    }
    // Persist ID so future calls skip the API lookup
    if (id && localClientId) {
      const localClient = getClient(localClientId);
      if (localClient) { localClient.clockifyId = id; saveState(); }
    }
    return id;
  } catch (e) { console.warn('clockifyUpsertClient:', e); }
  return null;
}

async function clockifyUpsertProject(apiKey, wsId, name, clockifyClientId, localClientId, localProjectId) {
  // Use cached Clockify ID if available — avoids lookup by name entirely
  if (localClientId && localProjectId) {
    const localProject = getProject(localClientId, localProjectId);
    if (localProject?.clockifyId) return localProject.clockifyId;
  }
  try {
    let id = null;
    const normName = name.replace(/\s+/g, ' ').trim();
    const r = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/projects?name=${encodeURIComponent(normName)}&page-size=50`, { headers: { 'X-Api-Key': apiKey } });
    if (r.ok) {
      const list = await r.json();
      const found = list.find(x => x.name.replace(/\s+/g, ' ').trim().toLowerCase() === normName.toLowerCase());
      if (found) id = found.id;
    }
    if (!id) {
      const body = { name, isPublic: false, color: '#6366f1' };
      if (clockifyClientId) body.clientId = clockifyClientId;
      const cr = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/projects`, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (cr.ok) { const x = await cr.json(); id = x.id; }
      else {
        const errText = await cr.text();
        // Project already exists (Clockify returns 400 + code 501) — fetch it by listing all
        if (cr.status === 400) {
          const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
          const allR = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/projects?page-size=500`, { headers: { 'X-Api-Key': apiKey } });
          if (allR.ok) {
            const all = await allR.json();
            const found = all.find(x => norm(x.name) === norm(name));
            if (found) id = found.id;
          }
        }
        if (!id) console.warn('Clockify create project failed:', cr.status, errText);
      }
    }
    // Persist ID so future calls skip the API lookup
    if (id && localClientId && localProjectId) {
      const localProject = getProject(localClientId, localProjectId);
      if (localProject) { localProject.clockifyId = id; saveState(); }
    }
    return id;
  } catch (e) { console.warn('clockifyUpsertProject:', e); }
  return null;
}

async function clockifyUpsertTask(apiKey, wsId, projectId, taskName, localClientId, localProjectId, localTaskId) {
  if (!taskName) return null;
  // Use cached Clockify task ID if available
  if (localClientId && localProjectId && localTaskId) {
    const localTask = getTask(localClientId, localProjectId, localTaskId);
    if (localTask?.clockifyTaskId) return localTask.clockifyTaskId;
  }
  try {
    const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const r = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/projects/${projectId}/tasks?page-size=100`, { headers: { 'X-Api-Key': apiKey } });
    if (r.ok) {
      const list = await r.json();
      const found = list.find(x => norm(x.name) === norm(taskName));
      if (found) {
        if (localClientId && localProjectId && localTaskId) {
          const localTask = getTask(localClientId, localProjectId, localTaskId);
          if (localTask) { localTask.clockifyTaskId = found.id; saveState(); }
        }
        return found.id;
      }
    }
    const cr = await fetch(`https://api.clockify.me/api/v1/workspaces/${wsId}/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: taskName.replace(/\s+/g, ' ').trim(), status: 'ACTIVE' })
    });
    if (cr.ok) {
      const t = await cr.json();
      if (localClientId && localProjectId && localTaskId) {
        const localTask = getTask(localClientId, localProjectId, localTaskId);
        if (localTask) { localTask.clockifyTaskId = t.id; saveState(); }
      }
      return t.id;
    }
    console.warn('Clockify create task failed:', cr.status, await cr.text());
  } catch (e) { console.warn('clockifyUpsertTask:', e); }
  return null;
}

async function clockifyGetExistingReportNames(apiKey, wsId) {
  try {
    const res = await fetch(`https://reports.api.clockify.me/v1/workspaces/${wsId}/shared-reports?page-size=200`, {
      headers: { 'X-Api-Key': apiKey }
    });
    if (!res.ok) return [];
    const raw  = await res.json();
    const list = Array.isArray(raw) ? raw : (raw.data || raw.reports || []);
    return list.map(r => (r.name || '').toLowerCase());
  } catch { return []; }
}

async function clockifyCreateSharedReport(filterType, clockifyEntityId, name) {
  const apiKey = state.clockifyApiKey;
  const wsId   = CLOCKIFY_WORKSPACE;
  // Build unique name: append suffix if already taken
  const existing = await clockifyGetExistingReportNames(apiKey, wsId);
  let uniqueName = name;
  if (existing.includes(name.toLowerCase())) {
    let i = 1;
    while (existing.includes(`${name} ${i}`.toLowerCase())) i++;
    uniqueName = `${name} ${i}`;
  }
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const filter = {
    dateRangeType: 'THIS_MONTH',
    dateRangeStart: new Date(y, m, 1).toISOString(),
    dateRangeEnd:   new Date(y, m + 1, 0, 23, 59, 59, 999).toISOString(),
    detailedFilter: { options: { totals: 'CALCULATE' } },
  };
  if (filterType === 'project') {
    filter.projects = { contains: 'CONTAINS', ids: [clockifyEntityId], status: 'ALL' };
  } else {
    filter.clients = { contains: 'CONTAINS', ids: [clockifyEntityId], status: 'ALL' };
  }
  const res = await fetch(`https://reports.api.clockify.me/v1/workspaces/${wsId}/shared-reports`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: uniqueName, type: 'DETAILED', isPublic: true, fixedDate: false, filter })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

async function openClientSharedReport(cid) {
  const c = getClient(cid);
  if (!c) return;
  const apiKey = state.clockifyApiKey;
  if (!apiKey) { showToast('יש להגדיר מפתח API של Clockify תחילה', 'error'); return; }
  if (c.clockifySharedReportId) {
    window.open(`https://app.clockify.me/shared/${c.clockifySharedReportId}`, '_blank');
    return;
  }
  showToast('יוצר דוח שיתופי ב-Clockify...', 'info');
  try {
    if (!c.clockifyId) {
      c.clockifyId = await clockifyUpsertClient(apiKey, CLOCKIFY_WORKSPACE, c.name, cid);
      saveState();
    }
    if (!c.clockifyId) { showToast('לא ניתן לסנכרן לקוח עם Clockify', 'error'); return; }
    const reportId = await clockifyCreateSharedReport('client', c.clockifyId, c.name);
    c.clockifySharedReportId = reportId;
    saveState();
    render();
    window.open(`https://app.clockify.me/shared/${reportId}`, '_blank');
    showToast('דוח שיתופי נוצר בהצלחה ✓', 'success');
  } catch (e) {
    console.error('openClientSharedReport:', e);
    showToast('שגיאה ביצירת דוח: ' + e.message, 'error');
  }
}

async function openProjectSharedReport(cid, pid) {
  const c = getClient(cid);
  const p = getProject(cid, pid);
  if (!p || !c) return;
  const apiKey = state.clockifyApiKey;
  if (!apiKey) { showToast('יש להגדיר מפתח API של Clockify תחילה', 'error'); return; }
  if (p.clockifySharedReportId) {
    window.open(`https://app.clockify.me/shared/${p.clockifySharedReportId}`, '_blank');
    return;
  }
  showToast('יוצר דוח שיתופי ב-Clockify...', 'info');
  try {
    if (!c.clockifyId) {
      c.clockifyId = await clockifyUpsertClient(apiKey, CLOCKIFY_WORKSPACE, c.name, cid);
      if (c.clockifyId) saveState();
    }
    if (!p.clockifyId) {
      p.clockifyId = await clockifyUpsertProject(apiKey, CLOCKIFY_WORKSPACE, p.name, c.clockifyId, cid, pid);
      if (p.clockifyId) saveState();
    }
    if (!p.clockifyId) { showToast('לא ניתן לסנכרן פרויקט עם Clockify', 'error'); return; }
    const reportId = await clockifyCreateSharedReport('project', p.clockifyId, `${c.name} - ${p.name}`);
    p.clockifySharedReportId = reportId;
    saveState();
    render();
    window.open(`https://app.clockify.me/shared/${reportId}`, '_blank');
    showToast('דוח שיתופי נוצר בהצלחה ✓', 'success');
  } catch (e) {
    console.error('openProjectSharedReport:', e);
    showToast('שגיאה ביצירת דוח: ' + e.message, 'error');
  }
}

// ============================================================
// FILTERS
// ============================================================
function applySortBy(tasks) {
  const s = state.filters.sortBy;
  if (!s || s === 'manual') return tasks;
  const PMAP = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort((a, b) => {
    if (s === 'priority') return (PMAP[a.priority] ?? 1) - (PMAP[b.priority] ?? 1);
    if (s === 'dueDate') {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    if (s === 'title') return a.title.localeCompare(b.title, 'he');
    if (s === 'time')  return (b.timeTotal || 0) - (a.timeTotal || 0);
    return 0;
  });
}

function applyFilters(tasks) {
  const f = state.filters;
  const filtered = tasks.filter(t => {
    if (f.status !== 'all') {
      // 'open' filter shows both open and in-progress (in-progress = timer running)
      if (f.status === STATUS.OPEN) { if (t.status === STATUS.DONE) return false; }
      else if (t.status !== f.status) return false;
    }
    if (f.priority !== 'all' && t.priority !== f.priority) return false;
    if (f.tag      !== 'all' && !(t.tags || []).includes(f.tag)) return false;
    return true;
  });
  return applySortBy(filtered);
}

function applyTodayFilters(items) {
  const f = state.filters;
  // If saved clientId no longer exists in current clients, reset it to 'all'
  const validClientId = (f.clientId && f.clientId !== 'all' && state.clients.find(c => c.id === f.clientId))
    ? f.clientId : 'all';
  if (validClientId !== f.clientId) { f.clientId = 'all'; saveState(); }

  const filtered = items.filter(({ client, task }) => {
    // In today view: 'open' means "not done" — both open + in-progress are relevant
    if (f.status !== 'all') {
      if (f.status === STATUS.OPEN) { if (task.status === STATUS.DONE) return false; }
      else if (task.status !== f.status) return false;
    }
    if (f.priority !== 'all' && task.priority !== f.priority) return false;
    if (f.tag      !== 'all' && !(task.tags || []).includes(f.tag)) return false;
    if (validClientId !== 'all' && client.id !== validClientId) return false;
    return true;
  });
  const s = f.sortBy;
  if (!s || s === 'manual') return filtered;
  const PMAP = { high: 0, medium: 1, low: 2 };
  return [...filtered].sort(({ task: a }, { task: b }) => {
    if (s === 'priority') return (PMAP[a.priority] ?? 1) - (PMAP[b.priority] ?? 1);
    if (s === 'dueDate') {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1; if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    if (s === 'title') return a.title.localeCompare(b.title, 'he');
    if (s === 'time')  return (b.timeTotal || 0) - (a.timeTotal || 0);
    return 0;
  });
}

// ============================================================
// BULK SELECTION
// ============================================================
function toggleBulkMode() {
  bulkMode = !bulkMode;
  bulkSelected = [];
  bulkVisibleItems = [];
  render();
}

function toggleBulkSelect(cid, pid, tid) {
  const idx = bulkSelected.findIndex(s => s.tid === tid);
  if (idx === -1) bulkSelected.push({ cid, pid, tid });
  else bulkSelected.splice(idx, 1);
  render();
}

function bulkSelectAll() {
  const allSelected = bulkVisibleItems.length > 0 &&
    bulkVisibleItems.every(item => bulkSelected.some(s => s.tid === item.tid));
  if (allSelected) {
    bulkSelected = [];
  } else {
    bulkSelected = [...bulkVisibleItems];
  }
  render();
}

function renderBulkBar() {
  if (!bulkMode) return '';
  const count = bulkSelected.length;
  const allSelected = bulkVisibleItems.length > 0 &&
    bulkVisibleItems.every(item => bulkSelected.some(s => s.tid === item.tid));
  const dis = count === 0 ? 'disabled' : '';
  return `<div class="bulk-bar">
    <button class="btn btn-ghost btn-sm" onclick="toggleBulkMode()">✕ ביטול</button>
    <button class="btn btn-ghost btn-sm" onclick="bulkSelectAll()">${allSelected ? 'בטל הכל' : 'בחר הכל'}</button>
    <span class="bulk-count">${count > 0 ? count + ' נבחרו' : 'לא נבחרו'}</span>
    <div class="bulk-bar-sep"></div>
    <button class="btn btn-ghost btn-sm" ${dis} onclick="bulkSetStatus('done')">✓ סמן הושלם</button>
    <button class="btn btn-ghost btn-sm" ${dis} onclick="bulkSetStatus('open')">○ סמן פתוח</button>
    <div class="bulk-bar-sep"></div>
    <button class="btn btn-ghost btn-sm" ${dis} onclick="bulkSetPriority('high')">🔴 גבוה</button>
    <button class="btn btn-ghost btn-sm" ${dis} onclick="bulkSetPriority('medium')">🟡 בינוני</button>
    <button class="btn btn-ghost btn-sm" ${dis} onclick="bulkSetPriority('low')">🟢 נמוך</button>
    <div class="bulk-bar-sep"></div>
    <button class="btn btn-ghost btn-sm btn-danger" ${dis} onclick="bulkDelete()">🗑 מחק</button>
  </div>`;
}

function bulkSetStatus(newStatus) {
  if (bulkSelected.length === 0) return;
  const now = Date.now();
  for (const { cid, pid, tid } of bulkSelected) {
    const t = getTask(cid, pid, tid);
    if (!t) continue;
    if (newStatus === STATUS.DONE && state.activeTimer?.taskId === tid) stopTimer();
    t.status = newStatus;
    t.completedAt = newStatus === STATUS.DONE ? now : null;
    (t.activityLog = t.activityLog || []).push({ type: newStatus === STATUS.DONE ? 'done' : 'reopened', timestamp: now });
  }
  saveState();
  bulkSelected = [];
  bulkMode = false;
  render();
  showToast(`סטטוס עודכן ✓`, 'success');
}

function bulkSetPriority(priority) {
  if (bulkSelected.length === 0) return;
  for (const { cid, pid, tid } of bulkSelected) {
    const t = getTask(cid, pid, tid);
    if (t) t.priority = priority;
  }
  saveState();
  bulkSelected = [];
  bulkMode = false;
  render();
  showToast(`עדיפות עודכנה ✓`, 'success');
}

function bulkDelete() {
  if (bulkSelected.length === 0) return;
  const count = bulkSelected.length;
  if (!confirm(`למחוק ${count} משימות?`)) return;
  for (const { cid, pid, tid } of bulkSelected) {
    deleteTask(cid, pid, tid);
  }
  saveState();
  bulkSelected = [];
  bulkMode = false;
  render();
  showToast(`${count} משימות נמחקו`, 'info');
}

// ============================================================
// NAVIGATION
// ============================================================
function resetViewFilters() {
  state.filters.status = STATUS.OPEN;
  state.selectedTaskId = null; state.panelClientId = null; state.panelProjectId = null;
  bulkMode = false; bulkSelected = []; bulkVisibleItems = [];
}

function navigateTo(view) {
  resetViewFilters();
  state.currentView = view;
  if (['reports','report','clockify-reports','daily-production','daily-local'].includes(view)) {
    state._reportsNavOpen = true;
  }
  saveState(); render();
}

function goReports() {
  state._reportsNavOpen = true;
  navigateTo('reports');
}

function goReportSection(key) {
  state.reportsSection = key;
  state._reportsNavOpen = true;
  navigateTo('reports');
}

function selectClient(cid) {
  resetViewFilters();
  if (state.selectedClientId === cid && state.currentView === 'client') {
    state.selectedClientId = null; state.currentView = 'today';
  } else {
    state.selectedClientId = cid; state.selectedProjectId = null; state.currentView = 'client';
  }
  saveState(); render();
}

function selectProject(cid, pid) {
  resetViewFilters();
  state.selectedClientId = cid; state.selectedProjectId = pid; state.currentView = 'project';
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
  panelActiveTab = 'details';
  saveState(); render();
}

function setFilter(key, value) {
  state.filters[key] = value;
  saveState(); renderMain(); renderTaskPanel();
}

function nextRecurringDate(task) {
  const r = task.recurring;
  if (!r) return null;
  const base = task.dueDate ? new Date(task.dueDate) : new Date();
  const d = new Date(base);
  if      (r.frequency === 'daily')   d.setDate(d.getDate() + 1);
  else if (r.frequency === 'weekly')  d.setDate(d.getDate() + 7);
  else if (r.frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (r.frequency === 'custom')  d.setDate(d.getDate() + (r.interval || 1));
  return d.toISOString().split('T')[0];
}

function cycleStatus(cid, pid, tid) {
  const t = getTask(cid, pid, tid);
  if (!t) return;
  // Circle is binary: open/in-progress → done, done → open
  const newStatus = t.status === STATUS.DONE ? STATUS.OPEN : STATUS.DONE;
  t.status = newStatus;

  // Stop timer automatically if this task (or its subtask) is running
  if (newStatus === STATUS.DONE && state.activeTimer?.taskId === tid) {
    stopTimer();
  }

  // Log the status change + track completedAt
  const now = Date.now();
  if (newStatus === STATUS.DONE) {
    t.completedAt = now;
  } else {
    t.completedAt = null;
  }
  (t.activityLog = t.activityLog || []).push({
    type: newStatus === STATUS.DONE ? 'done' : 'reopened',
    timestamp: now
  });

  // When a recurring task is completed, spawn the next occurrence
  if (newStatus === STATUS.DONE && t.recurring) {
    const nextDue = nextRecurringDate(t);
    const p = getProject(cid, pid);
    if (p && nextDue) {
      const nextTask = addTask(cid, pid, {
        title: t.title, description: t.description,
        priority: t.priority, tags: [...(t.tags || [])],
        dueDate: nextDue, estimatedMinutes: t.estimatedMinutes,
        recurring: { ...t.recurring }
      });
      showToast(`🔁 משימה חוזרת — נוצרה משימה חדשה לתאריך ${formatDisplayDate(nextDue)}`, 'info');
    }
  }

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

function toggleSidebar() {
  state._sidebarCollapsed = !state._sidebarCollapsed;
  renderSidebar();
}

function renderSidebar() {
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;
  const v          = state.currentView;
  const collapsed  = !!state._sidebarCollapsed;
  const sidebar    = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.toggle('sidebar-collapsed', collapsed);

  let html = `
    <div class="sb-toggle-row">
      <button class="sb-toggle-btn" onclick="toggleSidebar()" title="${collapsed ? 'הרחב' : 'כווץ'}">
        ${collapsed ? '‹' : '›'}
      </button>
    </div>
    <div class="nav-today ${v === 'today' ? 'active' : ''}" onclick="navigateTo('today')" title="היום">
      <span class="nav-today-icon">📅</span>
      <span class="sb-label">היום</span>
    </div>`;

  for (const c of state.clients) {
    if (c.archived) continue;
    const active = state.selectedClientId === c.id;
    html += `<div class="nav-client ${active ? 'active' : ''}" title="${esc(c.name)}">
      <div class="nav-client-header" onclick="selectClient('${c.id}')">
        <span style="font-size:15px">👤</span>
        <span class="nav-client-name sb-label">${esc(c.name)}</span>
        <span class="nav-chevron sb-label">›</span>
      </div>
      ${renderSidebarProjects(c)}
    </div>`;
  }

  const hasArchived = state.clients.some(c => c.archived || (c.projects||[]).some(p => p.archived));
  const isArchive = state.currentView === 'archive';
  if (hasArchived) {
    html += `<div class="nav-today ${isArchive ? 'active' : ''}" onclick="navigateTo('archive')" style="margin-top:8px;opacity:0.7" title="ארכיון">
      <span class="nav-today-icon">📦</span>
      <span class="sb-label">ארכיון</span>
    </div>`;
  }

  nav.innerHTML = html;

  // Highlight footer buttons based on current view
  const reportViews = ['reports','report','clockify-reports','daily-production','daily-local'];
  document.querySelectorAll('.settings-footer-btn').forEach(btn => {
    const isReports  = btn.getAttribute('onclick')?.includes('goReports');
    const isSettings = btn.getAttribute('onclick')?.includes("'settings'");
    btn.classList.toggle('active', isReports ? reportViews.includes(v) : isSettings ? v === 'settings' : false);
  });
}

function renderSidebarProjects(client) {
  let html = '<div class="nav-projects">';
  for (const p of (client.projects || [])) {
    if (p.archived) continue;
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
  try {
    switch (state.currentView) {
      case 'today':   el.innerHTML = renderTodayView();   break;
      case 'client':  el.innerHTML = renderClientView();  break;
      case 'project': el.innerHTML = renderProjectView(); break;
      case 'reports':           el.innerHTML = renderReportsHub();           break;
      case 'report':            el.innerHTML = renderReportView();           break;
      case 'clockify-reports':  el.innerHTML = renderClockifyReportsView();  break;
      case 'daily-production':  el.innerHTML = renderDailyProductionView();  break;
      case 'daily-local':       el.innerHTML = renderDailyLocalView();       break;
      case 'archive':           el.innerHTML = renderArchiveView();          break;
      case 'settings':          el.innerHTML = renderSettingsView();         break;
      default:          el.innerHTML = renderTodayView();
    }
  } catch(err) {
    console.error('renderMain error:', err);
    el.innerHTML = `<div class="view-container"><div class="empty-state" style="color:red">שגיאת רינדור: ${esc(String(err))}</div></div>`;
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

  bulkVisibleItems = items.map(({ client, project, task }) => ({ cid: client.id, pid: project.id, tid: task.id }));

  const clientOpts = [
    { value: 'all', label: 'כל הלקוחות' },
    ...state.clients.filter(c => !c.archived).map(c => ({ value: c.id, label: c.name }))
  ];

  return `<div class="view-container">
    <div class="view-header">
      <div class="view-header-title">
        <h2>📅 היום <span class="today-date">${d}/${m}/${y}</span></h2>
      </div>
      <div class="view-actions">
        <button class="btn ${bulkMode ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="toggleBulkMode()" title="בחירה מרובה">☑ בחירה</button>
      </div>
    </div>
    <div class="filter-bar">
      <span class="filter-label">פילטר:</span>
      ${renderFilterSelects(tags)}
      ${renderCsel('f-client', clientOpts, state.filters.clientId || 'all', "setFilter('clientId',{val})")}
    </div>
    ${renderBulkBar()}
    ${renderQuickAddBar()}
    <div class="task-list">${tasksHtml}</div>
  </div>`;
}

// ============================================================
// CLIENT VIEW
// ============================================================
// ============================================================
// REPORT VIEW
// ============================================================
function getDefaultReportRange() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const from = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const to   = new Date(y, m + 1, 0).toISOString().split('T')[0];
  return { mode: 'monthly', from, to };
}

function renderReportView() {
  if (!state.reportRange) state.reportRange = getDefaultReportRange();
  const rr = state.reportRange;
  const { mode, from, to } = rr;

  // Helper: sum seconds from timeEntries within the selected range
  function secsInRange(entries) {
    return (entries || []).filter(e => e.date >= from && e.date <= to)
                          .reduce((sum, e) => sum + (e.seconds || 0), 0);
  }

  // --- Date navigation helpers ---
  function fmtDate(d) { return d.toISOString().split('T')[0]; }
  function parseDate(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }

  // --- UI: mode tabs ---
  const modes = [
    { key: 'daily',   label: 'יומי' },
    { key: 'weekly',  label: 'שבועי' },
    { key: 'monthly', label: 'חודשי' },
    { key: 'custom',  label: 'טווח חופשי' },
  ];
  const modeTabs = modes.map(({ key, label }) =>
    `<button class="report-mode-tab ${mode === key ? 'active' : ''}" onclick="setReportMode('${key}')">${label}</button>`
  ).join('');

  // --- UI: range selector per mode ---
  let rangeSelector = '';
  if (mode === 'daily') {
    const prev = fmtDate(new Date(parseDate(from).getTime() - 86400000));
    const next = fmtDate(new Date(parseDate(from).getTime() + 86400000));
    const label = parseDate(from).toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    rangeSelector = `<div class="report-range-nav">
      <button class="report-nav-btn" onclick="setReportDaily('${prev}')">&#x276F;</button>
      <span class="report-range-label">${label}</span>
      <button class="report-nav-btn" onclick="setReportDaily('${next}')">&#x276E;</button>
      <input type="date" class="report-date-input" value="${from}" onchange="setReportDaily(this.value)">
    </div>`;
  } else if (mode === 'weekly') {
    // week: Mon-Sun
    const fromD = parseDate(from);
    const toD   = parseDate(to);
    const prevFrom = fmtDate(new Date(fromD.getTime() - 7 * 86400000));
    const nextFrom = fmtDate(new Date(fromD.getTime() + 7 * 86400000));
    const fmtShort = d => d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
    rangeSelector = `<div class="report-range-nav">
      <button class="report-nav-btn" onclick="setReportWeek('${prevFrom}')">&#x276F;</button>
      <span class="report-range-label">${fmtShort(fromD)} – ${fmtShort(toD)}</span>
      <button class="report-nav-btn" onclick="setReportWeek('${nextFrom}')">&#x276E;</button>
    </div>`;
  } else if (mode === 'monthly') {
    const [ry, rm] = from.split('-').map(Number);
    const prevD = new Date(ry, rm - 2, 1);
    const nextD = new Date(ry, rm, 1);
    const prevVal = fmtDate(prevD);
    const nextVal = fmtDate(nextD);
    const label = parseDate(from).toLocaleDateString('he-IL', { year: 'numeric', month: 'long' });
    // Build last 36 month options
    let monthOpts = '';
    for (let i = 0; i < 36; i++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const val = fmtDate(d).substring(0, 7) + '-01';
      const lbl = d.toLocaleDateString('he-IL', { year: 'numeric', month: 'long' });
      const curVal = `${from.substring(0,7)}-01`;
      monthOpts += `<option value="${fmtDate(d).substring(0,8)}01" ${fmtDate(d).substring(0,7) === from.substring(0,7) ? 'selected' : ''}>${lbl}</option>`;
    }
    rangeSelector = `<div class="report-range-nav">
      <button class="report-nav-btn" onclick="setReportMonthNav('${prevVal}')">&#x276F;</button>
      <select class="report-month-select" onchange="setReportMonthNav(this.value)">${monthOpts}</select>
      <button class="report-nav-btn" onclick="setReportMonthNav('${nextVal}')">&#x276E;</button>
    </div>`;
  } else if (mode === 'custom') {
    rangeSelector = `<div class="report-range-nav">
      <label class="report-custom-label">מ:</label>
      <input type="date" class="report-date-input" value="${from}" onchange="setReportCustom(this.value, '${to}')">
      <label class="report-custom-label">עד:</label>
      <input type="date" class="report-date-input" value="${to}" onchange="setReportCustom('${from}', this.value)">
    </div>`;
  }

  // --- Build data ---
  let grandTotal = 0, grandBillable = 0, grandBilling = 0;
  let clientsHtml = '';

  for (const c of state.clients) {
    if (c.archived) continue;
    let clientTotal = 0, clientBillable = 0, clientBilling = 0;
    let projectsHtml = '';

    for (const p of (c.projects || [])) {
      if (p.archived) continue;
      let projTotal = 0, projBillable = 0, projBilling = 0;
      let tasksHtml = '';

      for (const t of (p.tasks || [])) {
        const secs = secsInRange(t.timeEntries);
        const subtaskSecs = (t.subtasks || []).reduce((sum, s) => sum + secsInRange(s.timeEntries), 0);
        const totalSecs = secs + subtaskSecs;
        if (totalSecs === 0) continue;

        projTotal += totalSecs;
        if (p.billable) { projBillable += totalSecs; projBilling += (totalSecs / 3600) * (p.hourlyRate || 0); }

        const effSt = effectiveStatus(t);
        const statusIcon = STATUS_ICONS[effSt] || '○';
        const isDone = effSt === STATUS.DONE;
        tasksHtml += `<tr class="report-task-row ${isDone ? 'done' : ''}">
          <td class="report-task-title">${esc(t.title)}</td>
          <td class="report-task-status"><span class="badge badge-${effSt}">${statusIcon} ${STATUS_LABELS[effSt]}</span></td>
          <td class="report-task-time">${formatTime(totalSecs)}</td>
          ${p.billable && p.hourlyRate ? `<td class="report-task-billing">${formatMoney((totalSecs/3600)*p.hourlyRate)}</td>` : '<td></td>'}
        </tr>`;
      }

      if (projTotal === 0) continue;
      clientTotal += projTotal; clientBillable += projBillable; clientBilling += projBilling;

      projectsHtml += `<details class="report-project" open>
        <summary class="report-project-header">
          <span class="project-dot sm" style="background:${p.color}"></span>
          <span class="report-proj-name">${esc(p.name)}</span>
          ${p.billable ? '<span class="badge-billable">לחיוב</span>' : ''}
          <span class="report-time">${formatTime(projTotal)}</span>
          ${projBilling > 0 ? `<span class="report-billing">${formatMoney(projBilling)}</span>` : ''}
        </summary>
        <table class="report-tasks-table">
          <thead><tr><th>משימה</th><th>סטטוס</th><th>זמן</th><th>חיוב</th></tr></thead>
          <tbody>${tasksHtml}</tbody>
        </table>
      </details>`;
    }

    if (clientTotal === 0) continue;
    grandTotal += clientTotal; grandBillable += clientBillable; grandBilling += clientBilling;

    clientsHtml += `<details class="report-client-section" open>
      <summary class="report-client-header">
        <span class="report-client-avatar">${esc((c.name||'?').charAt(0).toUpperCase())}</span>
        <span class="report-client-name">${esc(c.name)}</span>
        <span class="report-client-time">${formatTime(clientTotal)}</span>
        ${clientBilling > 0 ? `<span class="report-client-billing">${formatMoney(clientBilling)}</span>` : ''}
      </summary>
      <div class="report-projects-list">${projectsHtml}</div>
    </details>`;
  }

  const emptyMsg = clientsHtml ? '' : `<div class="empty-state"><div class="empty-icon">📊</div><div>אין רשומות זמן לטווח זה</div><div style="font-size:12px;color:var(--text-muted);margin-top:8px">רשומות נוצרות אוטומטית בכל עצירת שעון</div></div>`;

  return `<div class="view-container report-view">
    <div class="view-header">
      <div class="view-header-title"><h2>📊 דוח שעות</h2></div>
      <div class="view-actions">
        <button class="btn btn-secondary" onclick="downloadReportPDF()" title="הורד PDF">⬇ PDF</button>
      </div>
    </div>
    <div class="report-controls">
      <div class="report-mode-tabs">${modeTabs}</div>
      ${rangeSelector}
    </div>
    <div class="report-grand-total">
      <span>סה"כ:</span>
      <span class="report-grand-time">${formatTime(grandTotal)}</span>
      ${grandBillable > 0 ? `<span class="report-grand-sep">|</span><span>לחיוב: ${formatTime(grandBillable)}</span>` : ''}
      ${grandBilling > 0 ? `<span class="report-grand-sep">|</span><span class="report-grand-billing">💰 ${formatMoney(grandBilling)}</span>` : ''}
    </div>
    ${clientsHtml}
    ${emptyMsg}
  </div>`;
}

function setReportMode(mode) {
  const now = new Date();
  function fmtDate(d) { return d.toISOString().split('T')[0]; }
  let from, to;
  if (mode === 'daily') {
    from = to = fmtDate(now);
  } else if (mode === 'weekly') {
    const day = now.getDay(); // 0=Sun
    const mon = new Date(now); mon.setDate(now.getDate() - ((day + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    from = fmtDate(mon); to = fmtDate(sun);
  } else if (mode === 'monthly') {
    const y = now.getFullYear(), m = now.getMonth();
    from = `${y}-${String(m+1).padStart(2,'0')}-01`;
    to   = fmtDate(new Date(y, m+1, 0));
  } else {
    // custom — keep previous range or default to current month
    const prev = state.reportRange || getDefaultReportRange();
    from = prev.from; to = prev.to;
  }
  state.reportRange = { mode, from, to };
  saveState();
  renderMain();
}

function setReportDaily(dateStr) {
  state.reportRange = { mode: 'daily', from: dateStr, to: dateStr };
  saveState(); renderMain();
}

function setReportWeek(fromStr) {
  function fmtDate(d) { return d.toISOString().split('T')[0]; }
  const [y, m, d] = fromStr.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end   = new Date(y, m - 1, d + 6);
  state.reportRange = { mode: 'weekly', from: fmtDate(start), to: fmtDate(end) };
  saveState(); renderMain();
}

function setReportMonthNav(firstDayStr) {
  function fmtDate(d) { return d.toISOString().split('T')[0]; }
  const [y, m] = firstDayStr.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2,'0')}-01`;
  const to   = fmtDate(new Date(y, m, 0));
  state.reportRange = { mode: 'monthly', from, to };
  saveState(); renderMain();
}

function setReportCustom(from, to) {
  if (from > to) to = from;
  state.reportRange = { mode: 'custom', from, to };
  saveState(); renderMain();
}

function downloadReportPDF() {
  const rr = state.reportRange || getDefaultReportRange();
  const { from, to } = rr;

  function secsInRange(entries) {
    return (entries || []).filter(e => e.date >= from && e.date <= to)
                          .reduce((sum, e) => sum + (e.seconds || 0), 0);
  }

  function fmtDate(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  const rangeLabel = from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
  const generatedAt = new Date().toLocaleDateString('he-IL', { year: 'numeric', month: 'long', day: 'numeric' });

  // Build per-client HTML sections
  let grandTotal = 0, grandBillable = 0, grandBilling = 0;
  let clientSections = '';

  for (const c of state.clients) {
    if (c.archived) continue;
    let clientTotal = 0, clientBillable = 0, clientBilling = 0;
    let projectRows = '';
    let anyTasks = false;

    for (const p of (c.projects || [])) {
      if (p.archived) continue;
      let projTotal = 0, projBillable = 0, projBilling = 0;
      let taskRows = '';

      for (const t of (p.tasks || [])) {
        const secs = secsInRange(t.timeEntries);
        const subtaskSecs = (t.subtasks || []).reduce((sum, s) => sum + secsInRange(s.timeEntries), 0);
        const totalSecs = secs + subtaskSecs;
        if (totalSecs === 0) continue;

        projTotal += totalSecs;
        const billing = p.billable && p.hourlyRate ? (totalSecs / 3600) * p.hourlyRate : 0;
        if (p.billable) { projBillable += totalSecs; projBilling += billing; }

        const statusMap = { open: 'פתוח', 'in-progress': 'בביצוע', done: 'הושלם' };
        taskRows += `<tr>
          <td class="task-name">${esc(t.title)}</td>
          <td class="task-status">${statusMap[effectiveStatus(t)] || t.status}</td>
          <td class="task-time">${formatTime(totalSecs)}</td>
          <td class="task-billing">${billing > 0 ? formatMoney(billing) : ''}</td>
        </tr>`;
        anyTasks = true;
      }

      if (projTotal === 0) continue;
      clientTotal += projTotal; clientBillable += projBillable; clientBilling += projBilling;

      projectRows += `<div class="project-block">
        <div class="project-header">
          <span class="project-dot" style="background:${p.color}"></span>
          <span class="project-name">${esc(p.name)}</span>
          ${p.billable ? '<span class="badge-bill">לחיוב</span>' : ''}
          <span class="project-time">${formatTime(projTotal)}</span>
          ${projBilling > 0 ? `<span class="project-billing">${formatMoney(projBilling)}</span>` : ''}
        </div>
        <table class="task-table">
          <thead><tr><th>משימה</th><th>סטטוס</th><th>זמן</th><th>חיוב</th></tr></thead>
          <tbody>${taskRows}</tbody>
        </table>
      </div>`;
    }

    if (clientTotal === 0) continue;
    grandTotal += clientTotal; grandBillable += clientBillable; grandBilling += clientBilling;

    const initial = (c.name || '?').charAt(0).toUpperCase();
    clientSections += `<div class="client-section">
      <div class="client-header">
        <div class="client-avatar">${esc(initial)}</div>
        <div class="client-info">
          <div class="client-name">${esc(c.name)}</div>
          ${c.email ? `<div class="client-contact">${esc(c.email)}</div>` : ''}
        </div>
        <div class="client-totals">
          <div class="client-time">${formatTime(clientTotal)}</div>
          ${clientBilling > 0 ? `<div class="client-billing">${formatMoney(clientBilling)}</div>` : ''}
        </div>
      </div>
      ${projectRows}
    </div>`;
  }

  const noData = !clientSections
    ? '<div class="no-data">אין רשומות זמן לתקופה זו</div>'
    : '';

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <title>דוח שעות – ${rangeLabel}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      direction: rtl; font-size: 12px;
      color: #1e1e2e; background: #fff;
      padding: 32px 40px;
    }
    /* ---- Page header ---- */
    .report-header {
      display: flex; justify-content: space-between; align-items: flex-start;
      border-bottom: 3px solid #4f46e5; padding-bottom: 16px; margin-bottom: 24px;
    }
    .report-title { font-size: 22px; font-weight: 700; color: #4f46e5; }
    .report-subtitle { font-size: 13px; color: #6b7280; margin-top: 4px; }
    .report-meta { text-align: left; font-size: 11px; color: #9ca3af; line-height: 1.8; }
    /* ---- Grand total bar ---- */
    .grand-total {
      background: #eef2ff; border-radius: 10px;
      padding: 12px 18px; margin-bottom: 24px;
      display: flex; gap: 24px; align-items: center; flex-wrap: wrap;
    }
    .grand-total-label { font-size: 13px; color: #4b5563; font-weight: 500; }
    .grand-total-time  { font-size: 20px; font-weight: 800; color: #4f46e5; }
    .grand-total-billing { font-size: 15px; font-weight: 700; color: #059669; }
    .grand-sep { color: #c7d2fe; font-size: 20px; }
    /* ---- Client section ---- */
    .client-section {
      border: 1px solid #e5e7eb; border-radius: 12px;
      margin-bottom: 24px; overflow: hidden; page-break-inside: avoid;
    }
    .client-header {
      display: flex; align-items: center; gap: 14px;
      background: #f8fafc; padding: 14px 18px;
      border-bottom: 1px solid #e5e7eb;
    }
    .client-avatar {
      width: 38px; height: 38px; border-radius: 50%;
      background: #4f46e5; color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; font-weight: 700; flex-shrink: 0;
    }
    .client-info { flex: 1; }
    .client-name { font-size: 16px; font-weight: 700; color: #111827; }
    .client-contact { font-size: 11px; color: #9ca3af; margin-top: 2px; }
    .client-totals { text-align: left; }
    .client-time { font-size: 17px; font-weight: 800; color: #4f46e5; }
    .client-billing { font-size: 13px; font-weight: 600; color: #059669; margin-top: 2px; }
    /* ---- Project block ---- */
    .project-block { margin: 0; }
    .project-header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 18px; background: #fff;
      border-bottom: 1px solid #f3f4f6; font-size: 13px;
    }
    .project-dot {
      width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
    }
    .project-name { flex: 1; font-weight: 600; color: #374151; }
    .project-time { font-weight: 700; color: #4f46e5; }
    .project-billing { font-weight: 600; color: #059669; font-size: 12px; margin-right: 8px; }
    .badge-bill {
      font-size: 10px; padding: 1px 6px;
      background: #d1fae5; color: #065f46; border-radius: 10px;
    }
    /* ---- Task table ---- */
    .task-table {
      width: 100%; border-collapse: collapse;
      font-size: 11px;
    }
    .task-table thead tr { background: #f9fafb; }
    .task-table th {
      padding: 6px 18px; text-align: right;
      color: #6b7280; font-weight: 600;
      border-bottom: 1px solid #e5e7eb;
    }
    .task-table td {
      padding: 7px 18px;
      border-bottom: 1px solid #f3f4f6;
      color: #374151;
    }
    .task-table tr:last-child td { border-bottom: none; }
    .task-time, .task-billing { text-align: left; font-weight: 600; }
    .task-status { color: #9ca3af; }
    /* ---- Footer ---- */
    .report-footer {
      margin-top: 32px; padding-top: 12px;
      border-top: 1px solid #e5e7eb;
      font-size: 10px; color: #9ca3af; text-align: center;
    }
    .no-data { text-align: center; padding: 40px; color: #9ca3af; font-size: 14px; }
    @media print {
      body { padding: 16px 20px; }
      .client-section { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="report-header">
    <div>
      <div class="report-title">📊 דוח שעות</div>
      <div class="report-subtitle">${rangeLabel}</div>
    </div>
    <div class="report-meta">
      <div>נוצר: ${generatedAt}</div>
    </div>
  </div>

  ${grandTotal > 0 ? `
  <div class="grand-total">
    <span class="grand-total-label">סה"כ לתקופה:</span>
    <span class="grand-total-time">${formatTime(grandTotal)}</span>
    ${grandBillable > 0 ? `<span class="grand-sep">|</span><span class="grand-total-label">לחיוב: <strong>${formatTime(grandBillable)}</strong></span>` : ''}
    ${grandBilling > 0 ? `<span class="grand-sep">|</span><span class="grand-total-billing">💰 ${formatMoney(grandBilling)}</span>` : ''}
  </div>` : ''}

  ${clientSections}
  ${noData}

  <div class="report-footer">מנהל המשימות &nbsp;|&nbsp; ${generatedAt}</div>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  // Auto-trigger print after fonts load
  win.onload = () => { win.focus(); win.print(); };
}

function renderArchiveView() {
  const archivedClients  = state.clients.filter(c => c.archived);
  const clientsWithArchivedProjects = state.clients.filter(c => !c.archived && (c.projects||[]).some(p => p.archived));

  let html = '';

  if (archivedClients.length) {
    html += `<h3 class="archive-section-title">לקוחות בארכיון</h3>`;
    for (const c of archivedClients) {
      const initial = (c.name||'?').charAt(0).toUpperCase();
      const projCount = (c.projects||[]).length;
      const taskCount = (c.projects||[]).reduce((s,p) => s + (p.tasks||[]).length, 0);
      html += `<div class="archive-client-row">
        <div class="archive-client-info">
          <div class="client-avatar sm">${esc(initial)}</div>
          <div>
            <div class="archive-client-name">${esc(c.name)}</div>
            <div class="archive-client-meta">${projCount} פרויקטים · ${taskCount} משימות</div>
          </div>
        </div>
        <div class="archive-actions">
          <button class="btn btn-ghost btn-sm" onclick="unarchiveClient('${c.id}')">↩️ שחזר</button>
          <button class="btn btn-ghost btn-sm btn-danger" onclick="confirmDeleteClient('${c.id}')">🗑️</button>
        </div>
      </div>`;
    }
  }

  if (clientsWithArchivedProjects.length) {
    html += `<h3 class="archive-section-title" style="margin-top:24px">פרויקטים בארכיון</h3>`;
    for (const c of clientsWithArchivedProjects) {
      const archivedProjs = (c.projects||[]).filter(p => p.archived);
      html += `<div class="archive-client-group">
        <div class="archive-group-label">👤 ${esc(c.name)}</div>
        <div class="projects-grid">${archivedProjs.map(p => renderProjectCard(c.id, p, true)).join('')}</div>
      </div>`;
    }
  }

  if (!html) {
    html = `<div class="empty-state"><div class="empty-icon">📦</div><div>הארכיון ריק</div></div>`;
  }

  return `<div class="view-container">
    <div class="view-header">
      <div class="view-header-title"><h2>📦 ארכיון</h2></div>
    </div>
    ${html}
  </div>`;
}

function renderClientView() {
  const c = getClient(state.selectedClientId);
  if (!c) return '<div class="view-container"><div class="empty-state">לקוח לא נמצא</div></div>';

  const initial = (c.name || '?').charAt(0).toUpperCase();
  const infoDetail = [
    c.email ? `<div class="client-detail">📧 ${esc(c.email)}</div>` : '',
    c.phone ? `<div class="client-detail">📞 ${esc(c.phone)}</div>` : ''
  ].join('');

  const projCards = (c.projects || []).filter(p => !p.archived).map(p => renderProjectCard(c.id, p)).join('');
  const archivedProjCards = (c.projects || []).filter(p => p.archived).map(p => renderProjectCard(c.id, p, true)).join('');

  const clientActualSecs = (c.projects || []).reduce((sum, p) =>
    sum + (p.tasks || []).reduce((s, t) =>
      s + (t.timeTotal || 0) + (t.subtasks || []).reduce((ss, sub) => ss + (sub.timeTotal || 0), 0), 0), 0);
  const clientEstMins = (c.projects || []).reduce((sum, p) =>
    sum + (p.tasks || []).reduce((s, t) => s + (t.estimatedMinutes || 0), 0), 0);
  const clientBillableSecs = (c.projects || []).filter(p => p.billable).reduce((sum, p) =>
    sum + (p.tasks || []).reduce((s, t) =>
      s + (t.timeTotal || 0) + (t.subtasks || []).reduce((ss, sub) => ss + (sub.timeTotal || 0), 0), 0), 0);
  const clientBillingTotal = (c.projects || []).filter(p => p.billable && p.hourlyRate > 0).reduce((sum, p) => {
    const secs = (p.tasks || []).reduce((s, t) =>
      s + (t.timeTotal || 0) + (t.subtasks || []).reduce((ss, sub) => ss + (sub.timeTotal || 0), 0), 0);
    return sum + (secs / 3600) * p.hourlyRate;
  }, 0);
  const clientTimeBar = clientActualSecs > 0 || clientEstMins > 0 ? `
    <div class="client-time-summary">
      <span class="time-label">סה"כ זמן:</span>
      <span class="time-actual">⏱ ${formatTime(clientActualSecs)}</span>
      ${clientEstMins > 0 ? `<span class="time-sep">/</span><span class="time-estimated">${formatEstimate(clientEstMins)} מתוכנן</span>` : ''}
      ${clientBillingTotal > 0 ? `<span class="billing-amount total">💰 ${formatMoney(clientBillingTotal)}</span>` : ''}
    </div>` : '';

  return `<div class="view-container">
    <div class="view-header">
      <h2>👤 ${esc(c.name)}</h2>
      <div class="view-actions">
        <button class="btn btn-ghost btn-sm" onclick="openClientSharedReport('${c.id}')" title="${c.clockifySharedReportId ? 'פתח דוח Clockify' : 'צור דוח שיתופי ב-Clockify'}">📊 ${c.clockifySharedReportId ? 'דוח Clockify' : 'צור דוח'}</button>
        <button class="btn btn-ghost btn-sm" onclick="showEditClientModal('${c.id}')">✏️ עריכה</button>
        <button class="btn btn-ghost btn-sm" onclick="archiveClient('${c.id}')" title="העבר לארכיון">📦 ארכיון</button>
        <button class="btn btn-ghost btn-sm btn-danger" onclick="confirmDeleteClient('${c.id}')">🗑️ מחיקה</button>
      </div>
    </div>
    <div class="client-info-card">
      <div class="client-avatar">${initial}</div>
      <div class="client-info-body">
        <div class="client-info-name">${esc(c.name)}</div>
        <div class="client-info-details">${infoDetail}</div>
        ${c.notes ? `<div class="client-notes">📝 ${esc(c.notes)}</div>` : ''}
      ${clientTimeBar}
      </div>
    </div>
    <div class="section-header">
      <h3>פרויקטים (${(c.projects||[]).filter(p=>!p.archived).length})</h3>
      <button class="btn btn-primary btn-sm" onclick="showAddProjectModal('${c.id}')">＋ פרויקט חדש</button>
    </div>
    <div class="projects-grid">
      ${projCards || '<div class="empty-state sm">אין פרויקטים עדיין</div>'}
    </div>
    ${archivedProjCards ? `<details class="archived-section">
      <summary class="archived-section-header">📦 פרויקטים בארכיון (${(c.projects||[]).filter(p=>p.archived).length})</summary>
      <div class="projects-grid">${archivedProjCards}</div>
    </details>` : ''}
  </div>`;
}

function renderProjectCard(cid, p, isArchivedView = false) {
  const tasks      = p.tasks || [];
  const total      = tasks.length;
  const done       = tasks.filter(t => effectiveStatus(t) === STATUS.DONE).length;
  const inProgress = tasks.filter(t => effectiveStatus(t) === STATUS.IN_PROGRESS).length;
  const open       = tasks.filter(t => effectiveStatus(t) === STATUS.OPEN).length;
  const client = getClient(cid);
  const isInbox = client?._inbox;
  const actualSecs = (p.tasks || []).reduce((sum, t) =>
    sum + (t.timeTotal || 0) + (t.subtasks || []).reduce((s, sub) => s + (sub.timeTotal || 0), 0), 0);
  const estimatedMins = (p.tasks || []).reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0);
  const billing = calcBilling(actualSecs, p.hourlyRate);
  const timeStats = actualSecs > 0 || estimatedMins > 0 || p.billable
    ? `<div class="project-card-time">
        ${p.billable ? `<span class="badge-billable">💰 Billable</span>` : ''}
        <span class="time-actual">⏱ ${formatTime(actualSecs)}</span>
        ${estimatedMins > 0 ? `<span class="time-sep">/</span><span class="time-estimated">${formatEstimate(estimatedMins)} מתוכנן</span>` : ''}
        ${billing !== null ? `<span class="billing-amount">${formatMoney(billing)}</span>` : ''}
       </div>` : '';
  return `<div class="project-card ${isInbox ? 'project-card-inbox' : ''} ${isArchivedView ? 'project-card-archived' : ''}" onclick="${isArchivedView ? '' : `selectProject('${cid}','${p.id}')`}">
    <div class="project-card-header">
      <span class="project-dot lg" style="background:${p.color}"></span>
      <span class="project-card-name">${esc(p.name)}</span>
      ${isInbox ? '<span class="inbox-badge">ללא לקוח</span>' : ''}
      ${isArchivedView ? '<span class="archive-badge">📦 ארכיון</span>' : ''}
    </div>
    <div class="project-card-stats">
      ${open > 0 ? `<span class="stat-open">${open} פתוחות</span>` : ''}
      ${inProgress > 0 ? `<span class="stat-inprogress">${inProgress} בביצוע</span>` : ''}
      ${done > 0 ? `<span class="stat-done">${done} הושלמו</span>` : ''}
      ${total === 0 ? `<span class="stat-empty">אין משימות</span>` : `<span class="stat-total">סה"כ ${total}</span>`}
    </div>
    ${timeStats}
    <div class="project-card-actions" onclick="event.stopPropagation()">
      ${isArchivedView
        ? `<button class="btn-icon" onclick="unarchiveProject('${cid}','${p.id}')" title="שחזר">↩️ שחזר</button>
           <button class="btn-icon danger" onclick="confirmDeleteProject('${cid}','${p.id}')" title="מחיקה">🗑️</button>`
        : `${isInbox ? `<button class="btn-icon" onclick="showAssignClientModal('${cid}','${p.id}')" title="שייך ללקוח">🔗</button>` : ''}
           ${(() => { const at = state.activeTimer; const isPlanning = at && at.type === 'planning' && at.projectId === p.id; return `<button class="btn-icon ${isPlanning ? 'running' : ''}" onclick="${isPlanning ? 'stopTimer()' : `startProjectPlanningTimer('${cid}','${p.id}')`}" title="אפיון ותכנון">${isPlanning ? '⏸' : '⏱'}</button>`; })()}
           <button class="btn-icon" onclick="openProjectSharedReport('${cid}','${p.id}')" title="${p.clockifySharedReportId ? 'פתח דוח Clockify' : 'צור דוח Clockify'}">📊</button>
           <button class="btn-icon" onclick="showEditProjectModal('${cid}','${p.id}')" title="עריכה">✏️</button>
           <button class="btn-icon" onclick="archiveProject('${cid}','${p.id}')" title="ארכיון">📦</button>
           <button class="btn-icon danger" onclick="confirmDeleteProject('${cid}','${p.id}')" title="מחיקה">🗑️</button>`
      }
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

  const projActualSecs = (p.tasks || []).reduce((sum, t) =>
    sum + (t.timeTotal || 0) + (t.subtasks || []).reduce((s, sub) => s + (sub.timeTotal || 0), 0), 0);
  const projEstMins = (p.tasks || []).reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0);
  const projBilling = calcBilling(projActualSecs, p.hourlyRate);
  const projTimeBar = projActualSecs > 0 || projEstMins > 0 || p.billable ? `
    <div class="project-view-time">
      ${p.billable ? `<span class="badge-billable">💰 Billable</span>` : ''}
      <span class="time-label">סה"כ זמן:</span>
      <span class="time-actual">⏱ ${formatTime(projActualSecs)}</span>
      ${projEstMins > 0 ? `<span class="time-sep">/</span><span class="time-estimated">${formatEstimate(projEstMins)} מתוכנן</span>` : ''}
      ${projBilling !== null ? `<span class="billing-amount">${formatMoney(projBilling)}</span>` : ''}
      ${p.hourlyRate > 0 ? `<span class="time-label">(${formatMoney(p.hourlyRate)}/ש')</span>` : ''}
    </div>` : '';

  bulkVisibleItems = filtered.map(t => ({ cid: c.id, pid: p.id, tid: t.id }));

  const tasksHtml = filtered.length === 0
    ? `<div class="empty-state"><div class="empty-icon">✓</div><div>אין משימות מתאימות</div></div>`
    : filtered.map(t => renderTaskCard(t, c.id, p.id, {})).join('');

  return `<div class="view-container">
    <div class="view-header">
      <div class="view-header-title">
        <span class="project-dot lg" style="background:${p.color}"></span>
        <div>
          <button class="breadcrumb breadcrumb-btn" onclick="selectClient('${c.id}')">${esc(c.name)}</button>
          <h2>${esc(p.name)}</h2>
        </div>
      </div>
      <div class="view-actions">
        ${(() => { const at = state.activeTimer; const isPlanning = at && at.type === 'planning' && at.projectId === p.id; return `<button class="btn ${isPlanning ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="${isPlanning ? 'stopTimer()' : `startProjectPlanningTimer('${c.id}','${p.id}')`}" title="אפיון ותכנון">${isPlanning ? '⏸ עצור' : '⏱ אפיון ותכנון'}</button>`; })()}
        <button class="btn btn-ghost btn-sm" onclick="openProjectSharedReport('${c.id}','${p.id}')" title="${p.clockifySharedReportId ? 'פתח דוח Clockify' : 'צור דוח שיתופי ב-Clockify'}">📊 ${p.clockifySharedReportId ? 'דוח Clockify' : 'צור דוח'}</button>
        <button class="btn ${bulkMode ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="toggleBulkMode()" title="בחירה מרובה">☑ בחירה</button>
        <button class="btn btn-ghost btn-sm" onclick="showEditProjectModal('${c.id}','${p.id}')">✏️</button>
        <button class="btn btn-ghost btn-sm" onclick="archiveProject('${c.id}','${p.id}')" title="העבר לארכיון">📦</button>
        <button class="btn btn-ghost btn-sm btn-danger" onclick="confirmDeleteProject('${c.id}','${p.id}')">🗑️</button>
        <button class="btn btn-primary btn-sm" onclick="showAddTaskModal('${c.id}','${p.id}')">＋ משימה חדשה</button>
      </div>
    </div>
    ${projTimeBar}
    <div class="filter-bar">
      <span class="filter-label">פילטר:</span>
      ${renderFilterSelects(tags)}
    </div>
    ${renderBulkBar()}
    ${renderQuickAddBar()}
    <div class="task-list">${tasksHtml}</div>
  </div>`;
}

function renderFilterSelects(tags) {
  const f = state.filters;
  const tagOpts = [{ value: 'all', label: 'כל התגיות' }, ...tags.map(t => ({ value: t, label: t }))];
  return (
    renderCsel('f-status', [
      { value: 'all',  label: 'כל הסטטוסים' },
      { value: 'open', label: 'פתוח / בביצוע' },
      { value: 'done', label: 'הושלם'         },
    ], f.status, "setFilter('status',{val})") +
    renderCsel('f-priority', [
      { value: 'all',    label: 'כל העדיפויות' },
      { value: 'high',   label: 'גבוה'         },
      { value: 'medium', label: 'בינוני'       },
      { value: 'low',    label: 'נמוך'         },
    ], f.priority, "setFilter('priority',{val})") +
    (tags.length ? renderCsel('f-tag', tagOpts, f.tag, "setFilter('tag',{val})") : '') +
    renderCsel('f-sort', [
      { value: 'manual',   label: 'מיון: ידני'      },
      { value: 'priority', label: 'מיון: עדיפות'    },
      { value: 'dueDate',  label: 'מיון: תאריך'     },
      { value: 'title',    label: 'מיון: שם'        },
      { value: 'time',     label: 'מיון: זמן'       },
    ], f.sortBy || 'manual', "setFilter('sortBy',{val})")
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

  const draggable = !bulkMode && state.filters.sortBy === 'manual';
  const effStatus = effectiveStatus(task);
  const isBulkChecked = bulkMode && bulkSelected.some(s => s.tid === task.id);
  return `<div class="task-card ${selected ? 'selected' : ''} ${effStatus === STATUS.DONE ? 'task-done' : ''} ${bulkMode ? 'bulk-mode' : ''} ${isBulkChecked ? 'bulk-checked' : ''}"
      ${draggable ? `draggable="true" data-task-id="${task.id}" data-client-id="${cid}" data-project-id="${pid}"` : ''}
      onclick="${bulkMode ? `toggleBulkSelect('${cid}','${pid}','${task.id}')` : `selectTask('${cid}','${pid}','${task.id}')`}">
    ${bulkMode
      ? `<div class="bulk-checkbox">${isBulkChecked ? '✓' : ''}</div>`
      : `<button class="status-btn status-${effStatus}"
          onclick="event.stopPropagation();cycleStatus('${cid}','${pid}','${task.id}')"
          title="${STATUS_LABELS[effStatus]}">${effStatus === STATUS.DONE ? '✓' : effStatus === STATUS.IN_PROGRESS ? '◐' : ''}</button>`
    }
    <div class="task-card-body">
      <div class="task-card-row1">
        <span class="task-title ${effStatus === STATUS.DONE ? 'done' : ''}">${esc(task.title)}</span>
      </div>
      ${showProject ? `<div class="task-project-label">
        <span class="project-dot sm" style="background:${projectColor}"></span>
        ${esc(clientName)} › ${esc(projectName)}
      </div>` : ''}
      <div class="task-meta">
        <span class="badge badge-${task.priority}">${PRIORITY_LABELS[task.priority] || task.priority}</span>
        ${(task.tags || []).map(t => `<span class="badge badge-tag">${esc(t)}</span>`).join('')}
        ${effStatus === STATUS.DONE && task.completedAt
          ? `<span class="badge badge-completed">✓ ${new Date(task.completedAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' })}</span>`
          : task.dueDate ? `<span class="badge badge-date ${overdue ? 'overdue' : ''}">${overdue ? '⚠ ' : ''}${formatDisplayDate(task.dueDate)}</span>` : ''}
        ${task.recurring ? `<span class="badge badge-recurring" title="חוזרת כל ${task.recurring.frequency === 'daily' ? 'יום' : task.recurring.frequency === 'weekly' ? 'שבוע' : task.recurring.frequency === 'monthly' ? 'חודש' : task.recurring.interval + ' ימים'}">🔁</span>` : ''}
        ${subtasksTotal > 0 ? `<span class="badge badge-subtasks">${subtasksDone}/${subtasksTotal} תתי-משימות</span>` : ''}
        ${ep?.over ? `<span class="badge badge-over">⚠ חריגה מהתכנון</span>` : ''}
      </div>
    </div>
    <div class="task-card-right">
      <div class="timer-wrap">
        <div class="timer-times">
          <span class="timer-display ${isRunning ? 'timer-running' : ''}" ${tickAttrs}>${formatTime(baseTime)}</span>
          ${task.estimatedMinutes ? `<span class="timer-estimated">/ ${formatEstimate(task.estimatedMinutes)}</span>` : ''}
        </div>
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

  const panelClient  = getClient(cid);
  const panelProject = getProject(cid, pid);

  return `<div class="panel-inner">
    <div class="panel-header">
      <button class="close-panel-btn" onclick="closeTaskPanel()">✕</button>
      <div class="panel-breadcrumb">
        <button class="panel-breadcrumb-btn" onclick="selectClient('${cid}');closeTaskPanel()">${esc(panelClient?.name)}</button>
        <span class="panel-breadcrumb-sep">›</span>
        <button class="panel-breadcrumb-btn" onclick="selectProject('${cid}','${pid}');closeTaskPanel()">${esc(panelProject?.name)}</button>
      </div>
      <div class="panel-header-actions">
        <button class="btn btn-ghost btn-sm" onclick="showMoveTaskModal('${cid}','${pid}','${task.id}')">📦 העברה</button>
        <button class="btn btn-ghost btn-sm btn-danger" onclick="confirmDeleteTask('${cid}','${pid}','${task.id}')">🗑️</button>
      </div>
    </div>
    <div class="panel-tabs">
      <button class="panel-tab ${panelActiveTab==='details'?'active':''}" onclick="setPanelTab('details')">פרטים</button>
      <button class="panel-tab ${panelActiveTab==='log'?'active':''}" onclick="setPanelTab('log')">לוג פעילות</button>
    </div>

    ${panelActiveTab === 'log' ? `<div class="panel-body panel-log-body">${buildActivityLog(task)}</div>` : `<div class="panel-body">

      <!-- Title -->
      <div class="panel-title-row">
        <button class="status-btn status-${effectiveStatus(task)}"
          onclick="cycleStatus('${cid}','${pid}','${task.id}')"
          title="${STATUS_LABELS[effectiveStatus(task)]}">${effectiveStatus(task) === STATUS.DONE ? '✓' : effectiveStatus(task) === STATUS.IN_PROGRESS ? '◐' : ''}</button>
        <input class="panel-title-input ${effectiveStatus(task) === STATUS.DONE ? 'done' : ''}"
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
          ${effectiveStatus(task) === STATUS.IN_PROGRESS
            ? `<span class="panel-status-derived">◐ בביצוע</span>`
            : renderCsel('panel-status', [
                { value: 'open', label: 'פתוח'  },
                { value: 'done', label: 'הושלם' },
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

      <!-- Recurring -->
      <div class="panel-field-block panel-recurring">
        <label>חזרתיות</label>
        <div class="panel-recurring-row">
          <label class="recurring-toggle">
            <input type="checkbox" id="panel-rec-on"
              ${task.recurring ? 'checked' : ''}
              onchange="togglePanelRecurring('${cid}','${pid}','${task.id}')">
            <span>חוזרת</span>
          </label>
          <div id="panel-rec-opts" style="display:${task.recurring ? 'flex' : 'none'};gap:8px;align-items:center">
            <select id="panel-rec-freq"
              onchange="savePanelRecurring('${cid}','${pid}','${task.id}')">
              <option value="daily"   ${task.recurring?.frequency==='daily'   ? 'selected':''}>כל יום</option>
              <option value="weekly"  ${task.recurring?.frequency==='weekly'  ? 'selected':''}>כל שבוע</option>
              <option value="monthly" ${task.recurring?.frequency==='monthly' ? 'selected':''}>כל חודש</option>
              <option value="custom"  ${task.recurring?.frequency==='custom'  ? 'selected':''}>כל X ימים</option>
            </select>
            <input id="panel-rec-interval" type="number" min="1" max="365"
              value="${task.recurring?.interval || 7}"
              style="width:60px;display:${task.recurring?.frequency==='custom' ? 'block' : 'none'}"
              placeholder="ימים"
              onchange="savePanelRecurring('${cid}','${pid}','${task.id}')">
          </div>
          ${task.recurring ? `<span class="panel-recurring-next">הבאה: ${formatDisplayDate(nextRecurringDate(task))}</span>` : ''}
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
        <div class="panel-desc-preview${task.description ? '' : ' empty'}"
          onclick="startEditDesc(this)"
        >${task.description ? linkify(task.description) : '<span class="placeholder">תיאור המשימה...</span>'}</div>
        <textarea class="panel-desc" style="display:none"
          onblur="finishEditDesc(this,'${cid}','${pid}','${task.id}')"
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
        </div>
        <div class="subtasks-list">${subtasksHtml}</div>
        <input class="subtask-quick-add" placeholder="＋ הוסף תת-משימה..." onkeydown="addPanelSubtask(event,'${cid}','${pid}','${task.id}')">
      </div>

    </div>`}
  </div>`;
}

function buildActivityLog(task) {
  const timeEntries = task.timeEntries || [];
  const activityLog = task.activityLog || [];

  const allEntries = [
    ...timeEntries.map(e => ({ ts: e.start,     type: 'work', entry: e })),
    ...activityLog.map(a => ({ ts: a.timestamp, type: a.type           })),
  ].sort((a, b) => b.ts - a.ts);

  const totalSecs    = timeEntries.reduce((s, e) => s + (e.seconds || 0), 0);
  const sessionCount = timeEntries.length;
  const doneCount    = activityLog.filter(a => a.type === 'done').length;

  const summaryHtml = (totalSecs > 0 || doneCount > 0) ? `
    <div class="log-summary">
      <div class="log-summary-item">
        <span class="log-summary-val">${formatTime(totalSecs)}</span>
        <span class="log-summary-lbl">זמן כולל</span>
      </div>
      <div class="log-summary-sep"></div>
      <div class="log-summary-item">
        <span class="log-summary-val">${sessionCount}</span>
        <span class="log-summary-lbl">סשנים</span>
      </div>
      <div class="log-summary-sep"></div>
      <div class="log-summary-item">
        <span class="log-summary-val">${doneCount}</span>
        <span class="log-summary-lbl">פעמי סגירה</span>
      </div>
    </div>` : '';

  if (!allEntries.length) {
    return `${summaryHtml}<div class="log-empty">
      <div class="log-empty-icon">📋</div>
      <div class="log-empty-text">אין פעילות מתועדת עדיין</div>
    </div>`;
  }

  const fmtTime = ts => new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

  // Group by YYYY-MM-DD for correct sort order
  const byDate = {};
  for (const e of allEntries) {
    const key = new Date(e.ts).toISOString().split('T')[0];
    const lbl = new Date(e.ts).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
    if (!byDate[key]) byDate[key] = { lbl, items: [] };
    byDate[key].items.push(e);
  }

  let html = summaryHtml;
  for (const key of Object.keys(byDate).sort().reverse()) {
    const { lbl, items } = byDate[key];
    let rows = '';
    for (const item of items) {
      if (item.type === 'work') {
        const e = item.entry;
        rows += `<div class="log-entry log-work">
          <div class="log-dot">⏱</div>
          <div class="log-content">
            <div class="log-label">סשן עבודה <span class="log-badge log-badge-time">${formatTime(e.seconds)}</span></div>
            <div class="log-meta">${fmtTime(e.start)} – ${fmtTime(e.end)}</div>
          </div>
        </div>`;
      } else if (item.type === 'done') {
        rows += `<div class="log-entry log-done">
          <div class="log-dot">✓</div>
          <div class="log-content">
            <div class="log-label">סומן כהושלם <span class="log-badge log-badge-done">הושלם</span></div>
            <div class="log-meta">${fmtTime(item.ts)}</div>
          </div>
        </div>`;
      } else if (item.type === 'reopened') {
        rows += `<div class="log-entry log-reopened">
          <div class="log-dot">↩</div>
          <div class="log-content">
            <div class="log-label">נפתח מחדש <span class="log-badge log-badge-open">פתוח</span></div>
            <div class="log-meta">${fmtTime(item.ts)}</div>
          </div>
        </div>`;
      }
    }
    html += `<div class="log-date-group">
      <div class="log-date-label">${lbl}</div>
      <div class="log-timeline">${rows}</div>
    </div>`;
  }
  return html;
}

// Save a single task field without re-rendering the panel (preserves focus)
function saveTaskField(cid, pid, tid, field, value, rerenderPanel = false) {
  updateTask(cid, pid, tid, { [field]: value });
  renderSidebar();
  if (rerenderPanel) renderTaskPanel();
}

function startEditDesc(previewEl) {
  const textarea = previewEl.nextElementSibling;
  previewEl.style.display = 'none';
  textarea.style.display = '';
  textarea.focus();
}

function finishEditDesc(textarea, cid, pid, tid) {
  saveTaskField(cid, pid, tid, 'description', textarea.value);
  const preview = textarea.previousElementSibling;
  if (textarea.value) {
    preview.innerHTML = linkify(textarea.value);
    preview.classList.remove('empty');
  } else {
    preview.innerHTML = '<span class="placeholder">תיאור המשימה...</span>';
    preview.classList.add('empty');
  }
  textarea.style.display = 'none';
  preview.style.display = '';
}

function setPanelTab(tab) {
  panelActiveTab = tab;
  renderTaskPanel();
}

function togglePanelRecurring(cid, pid, tid) {
  const on = document.getElementById('panel-rec-on')?.checked;
  const opts = document.getElementById('panel-rec-opts');
  if (opts) opts.style.display = on ? 'flex' : 'none';
  if (on) { savePanelRecurring(cid, pid, tid); }
  else { updateTask(cid, pid, tid, { recurring: null }); renderTaskPanel(); }
}

function savePanelRecurring(cid, pid, tid) {
  const freq = document.getElementById('panel-rec-freq')?.value || 'weekly';
  const intEl = document.getElementById('panel-rec-interval');
  if (intEl) intEl.style.display = freq === 'custom' ? 'block' : 'none';
  const interval = freq === 'custom' ? (parseInt(intEl?.value, 10) || 7) : null;
  updateTask(cid, pid, tid, { recurring: { frequency: freq, ...(interval ? { interval } : {}) } });
  renderTaskPanel();
}

function saveSubtaskField(cid, pid, tid, sid, field, value) {
  if (!value.trim()) return;
  updateSubtask(cid, pid, tid, sid, { [field]: value.trim() });
  renderMain();
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

function addPanelSubtask(e, cid, pid, tid) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const title = e.target.value.trim();
  if (!title) return;
  addSubtask(cid, pid, tid, { title });
  e.target.value = '';
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
      <input class="subtask-title-input ${sub.status===STATUS.DONE?'done':''}"
        value="${esc(sub.title)}"
        onblur="saveSubtaskField('${cid}','${pid}','${tid}','${sub.id}','title',this.value)"
        onkeydown="if(event.key==='Enter')this.blur();if(event.key==='Escape'){this.value=this.dataset.orig;this.blur();}" data-orig="${esc(sub.title)}">
      ${sub.description ? `<div class="subtask-desc">${esc(sub.description)}</div>` : ''}
    </div>
    <div class="subtask-actions">
      <span class="timer-display ${isActive?'timer-running':''}" style="font-size:11px;min-width:50px" ${tickAttrs}>${formatTime(isActive?base:base)}</span>
      <button class="timer-btn ${isActive?'running':''}" style="width:24px;height:24px;font-size:9px"
        onclick="${isActive?'stopTimer()':`startTimer('${cid}','${pid}','${tid}','${sub.id}')`}">${isActive?'⏸':'▶'}</button>
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

  const project = getProject(at.clientId, at.projectId);
  const isPlanningTimer = at.type === 'planning';
  const task    = isPlanningTimer ? null : getTask(at.clientId, at.projectId, at.taskId);
  const sub     = isPlanningTimer ? null : (at.subtaskId ? getSubtask(at.clientId, at.projectId, at.taskId, at.subtaskId) : null);
  const label   = isPlanningTimer ? 'אפיון ותכנון' : (sub ? sub.title : (task?.title || ''));
  const base    = isPlanningTimer ? 0 : ((sub ? sub.timeTotal : task?.timeTotal) || 0);

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
     <div class="form-group"><label>הערות</label><textarea id="f-notes" rows="3" placeholder="הערות..."></textarea></div>
     <div class="form-group"><label>תעריף שעתי ברירת מחדל (₪)</label><input id="f-rate" type="number" min="0" step="10" placeholder="0"></div>`,
    `<button class="btn btn-primary" onclick="submitAddClient()">הוסף לקוח</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitAddClient() {
  const name = fval('f-name');
  if (!name) { showToast('שם הלקוח חובה', 'error'); return; }
  const c = addClient({ name, email: fval('f-email'), phone: fval('f-phone'), notes: fval('f-notes'), defaultHourlyRate: parseFloat(fval('f-rate')) || 0 });
  closeModal(); selectClient(c.id);
}

function showEditClientModal(cid) {
  const c = getClient(cid); if (!c) return;
  showModal('עריכת לקוח',
    `<div class="form-group"><label>שם *</label><input id="f-name" value="${esc(c.name)}"></div>
     <div class="form-group"><label>אימייל</label><input id="f-email" type="email" value="${esc(c.email||'')}"></div>
     <div class="form-group"><label>טלפון</label><input id="f-phone" value="${esc(c.phone||'')}"></div>
     <div class="form-group"><label>הערות</label><textarea id="f-notes" rows="3">${esc(c.notes||'')}</textarea></div>
     <div class="form-group"><label>תעריף שעתי ברירת מחדל (₪)</label><input id="f-rate" type="number" min="0" step="10" value="${c.defaultHourlyRate||0}"></div>`,
    `<button class="btn btn-primary" onclick="submitEditClient('${cid}')">שמור</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitEditClient(cid) {
  const name = fval('f-name');
  if (!name) { showToast('שם הלקוח חובה', 'error'); return; }
  updateClient(cid, { name, email: fval('f-email'), phone: fval('f-phone'), notes: fval('f-notes'), defaultHourlyRate: parseFloat(fval('f-rate')) || 0 });
  closeModal(); render();
}

// ============================================================
// MODAL — ADD / EDIT PROJECT
// ============================================================
function showAddProjectModal(cid) {
  const c = getClient(cid);
  showModal('פרויקט חדש', buildProjectForm({}, c?.defaultHourlyRate || 0),
    `<button class="btn btn-primary" onclick="submitAddProject('${cid}')">הוסף פרויקט</button>
     <button class="btn btn-ghost" onclick="closeModal()">ביטול</button>`
  );
}

function submitAddProject(cid) {
  const name = fval('f-name');
  if (!name) { showToast('שם הפרויקט חובה', 'error'); return; }
  const color = document.querySelector('input[name="pcolor"]:checked')?.value || PROJECT_COLORS[0];
  const billable = document.getElementById('f-billable')?.checked || false;
  const hourlyRate = parseFloat(fval('f-rate')) || 0;
  const p = addProject(cid, { name, color, billable, hourlyRate });
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
  const billable = document.getElementById('f-billable')?.checked || false;
  const hourlyRate = parseFloat(fval('f-rate')) || 0;
  updateProject(cid, pid, { name, color, billable, hourlyRate });
  closeModal(); render();
}

function buildProjectForm(p, defaultHourlyRate = 0) {
  const swatches = PROJECT_COLORS.map((c, i) =>
    `<label class="color-option" title="${c}">
      <input type="radio" name="pcolor" value="${c}" ${(p.color||PROJECT_COLORS[0])===c?'checked':''}>
      <span class="color-swatch" style="background:${c};color:${c}"></span>
    </label>`
  ).join('');
  const rate = p.hourlyRate ?? defaultHourlyRate;
  return `<div class="form-group"><label>שם *</label><input id="f-name" value="${esc(p.name||'')}" placeholder="שם הפרויקט"></div>
    <div class="form-group"><label>צבע</label><div class="color-picker">${swatches}</div></div>
    <div class="form-group billing-row">
      <label class="toggle-label">
        <input type="checkbox" id="f-billable" ${p.billable ? 'checked' : ''}>
        <span>ניתן לחיוב (Billable)</span>
      </label>
    </div>
    <div class="form-group">
      <label>תעריף שעתי (₪)</label>
      <input id="f-rate" type="number" min="0" step="10" value="${rate||0}" placeholder="0">
    </div>`;
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

function readRecurringFromForm() {
  const on = document.getElementById('f-recurring-on')?.checked;
  if (!on) return null;
  const frequency = document.getElementById('f-rec-freq')?.value || 'weekly';
  const interval  = frequency === 'custom' ? (parseInt(document.getElementById('f-rec-interval')?.value, 10) || 7) : null;
  return { frequency, ...(interval ? { interval } : {}) };
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
    estimatedMinutes: estRaw > 0 ? estRaw : null,
    recurring: readRecurringFromForm()
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
    tags, recurring: readRecurringFromForm()
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
        <option value="done" ${sSel('done')}>הושלם</option>
      </select></div>` : ''}
    <div class="form-group recurring-group">
      <label class="recurring-label">
        <input type="checkbox" id="f-recurring-on" ${t.recurring ? 'checked' : ''}
          onchange="toggleRecurringUI()"> משימה חוזרת 🔁
      </label>
      <div id="recurring-opts" style="display:${t.recurring ? 'flex' : 'none'};gap:10px;margin-top:6px;align-items:center">
        <select id="f-rec-freq" onchange="toggleRecurringUI()">
          <option value="daily"   ${(t.recurring?.frequency||'weekly')==='daily'   ? 'selected':''}>כל יום</option>
          <option value="weekly"  ${(t.recurring?.frequency||'weekly')==='weekly'  ? 'selected':''}>כל שבוע</option>
          <option value="monthly" ${(t.recurring?.frequency||'weekly')==='monthly' ? 'selected':''}>כל חודש</option>
          <option value="custom"  ${(t.recurring?.frequency||'weekly')==='custom'  ? 'selected':''}>כל X ימים</option>
        </select>
        <input id="f-rec-interval" type="number" min="1" max="365"
          value="${t.recurring?.interval || 7}"
          style="width:70px;display:${(t.recurring?.frequency)==='custom'?'block':'none'}"
          placeholder="ימים">
      </div>
    </div>`;
}

function toggleRecurringUI() {
  const on  = document.getElementById('f-recurring-on')?.checked;
  const box = document.getElementById('recurring-opts');
  const frq = document.getElementById('f-rec-freq')?.value;
  const inp = document.getElementById('f-rec-interval');
  if (box) box.style.display = on ? 'flex' : 'none';
  if (inp) inp.style.display = frq === 'custom' ? 'block' : 'none';
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
// SETTINGS VIEW
// ============================================================
const REPORTS_SECTIONS = [
  { key: 'report',           icon: '📊', label: 'דוח שעות' },
  { key: 'clockify-reports', icon: '⏱', label: 'דוחות Clockify' },
  { key: 'daily-production', icon: '💰', label: 'ייצור יומי Clockify' },
  { key: 'daily-local',      icon: '📋', label: 'ייצור יומי מקומי' },
];

function setReportsSection(key) {
  state.reportsSection = key;
  saveState(); renderMain();
}

function renderReportsHub() {
  const section = state.reportsSection || 'report';

  const tabs = REPORTS_SECTIONS.map(s =>
    `<button class="reports-tab ${section === s.key ? 'active' : ''}" onclick="setReportsSection('${s.key}')">
      <span>${s.icon}</span><span>${s.label}</span>
    </button>`
  ).join('');

  let content = '';
  if (section === 'report')                content = renderReportView();
  else if (section === 'clockify-reports') content = renderClockifyReportsView();
  else if (section === 'daily-production') content = renderDailyProductionView();
  else if (section === 'daily-local')      content = renderDailyLocalView();

  content = content.replace(/^<div class="report-container">/, '<div class="reports-hub-content">');

  return `<div class="reports-hub-layout">
    <div class="reports-hub-tabs">${tabs}</div>
    <div class="reports-hub-body">${content}</div>
  </div>`;
}

const SETTINGS_SECTIONS = [
  { key: 'business',     icon: '🏢', label: 'פרטי עסק' },
  { key: 'backup',       icon: '💾', label: 'גיבוי ושחזור' },
  { key: 'integrations', icon: '🔗', label: 'אינטגרציות', header: true },
  { key: 'clockify',     icon: '⏱', label: 'Clockify' },
  { key: 'claude',       icon: '🤖', label: 'Claude AI' },
  { key: 'greenapi',     icon: '💬', label: 'Green API' },
  { key: 'accounting',   icon: '📒', label: 'חשבונאות' },
];

// ============================================================
// CLOCKIFY REPORTS VIEW
// ============================================================
function renderClockifyReportsView() {
  const apiKey = state.clockifyApiKey || state.integrations?.clockify?.apiKey;
  if (!apiKey) return `<div class="report-container"><div class="empty-state"><div class="empty-icon">⏱</div><div>יש להגדיר מפתח API של Clockify בהגדרות תחילה</div></div></div>`;

  const loaded  = Array.isArray(state._clockifyReportsList);
  const reports = loaded ? state._clockifyReportsList : null;

  if (reports === null) {
    if (!state._clockifyReportsLoading) loadClockifyReportsList();
    return `<div class="report-container"><div class="empty-state"><div class="empty-icon">⏳</div><div>טוען דוחות...</div></div></div>`;
  }

  const cards = reports.map(r => `
    <div class="ck-report-card">
      <div class="ck-report-card-info">
        <div class="ck-report-card-name">${esc(r.name)}</div>
        <div class="ck-report-card-type">${r.type || 'DETAILED'}</div>
      </div>
      <div class="ck-report-card-actions">
        <a href="https://app.clockify.me/shared/${r.id}" target="_blank" class="btn btn-sm btn-secondary">👁 צפה</a>
        <button class="btn btn-sm btn-danger" onclick="deleteClockifyReport('${r.id}')">🗑</button>
      </div>
    </div>`).join('');

  const empty = reports.length === 0
    ? `<div class="empty-state"><div class="empty-icon">📭</div><div>אין דוחות שיתופיים ב-Clockify</div></div>` : '';

  return `<div class="report-container">
    <div class="report-header">
      <h2 class="report-title">⏱ דוחות Clockify</h2>
      <span class="ck-reports-count">${reports.length} דוחות</span>
      <button class="btn btn-secondary btn-sm" onclick="loadClockifyReportsList()" style="margin-right:auto">🔄 רענן</button>
    </div>
    ${empty}
    <div class="ck-reports-list">${cards}</div>
  </div>`;
}

async function loadClockifyReportsList() {
  const apiKey = state.clockifyApiKey || state.integrations?.clockify?.apiKey;
  const wsId   = CLOCKIFY_WORKSPACE;
  state._clockifyReportsLoading = true;
  state._clockifyReportsList    = null;
  renderMain();
  try {
    const res = await fetch(`https://reports.api.clockify.me/v1/workspaces/${wsId}/shared-reports?page-size=200`, {
      headers: { 'X-Api-Key': apiKey }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    state._clockifyReportsList = Array.isArray(raw) ? raw : (raw.data || raw.reports || []);
  } catch(e) {
    showToast('שגיאה בטעינת דוחות: ' + e.message, 'error');
    state._clockifyReportsList = [];
  }
  state._clockifyReportsLoading = false;
  renderMain();
}

async function deleteClockifyReport(reportId) {
  const apiKey = state.clockifyApiKey || state.integrations?.clockify?.apiKey;
  const wsId   = CLOCKIFY_WORKSPACE;
  try {
    const res = await fetch(`https://reports.api.clockify.me/v1/workspaces/${wsId}/shared-reports/${reportId}`, {
      method: 'DELETE',
      headers: { 'X-Api-Key': apiKey }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Remove cached ID from clients/projects
    for (const c of state.clients) {
      if (c.clockifySharedReportId === reportId) delete c.clockifySharedReportId;
      for (const p of (c.projects || [])) {
        if (p.clockifySharedReportId === reportId) delete p.clockifySharedReportId;
      }
    }
    saveState();
    showToast('דוח נמחק ✓', 'success');
    state._clockifyReportsList = (state._clockifyReportsList || []).filter(r => r.id !== reportId);
    renderMain();
  } catch(e) {
    showToast('שגיאה במחיקת דוח: ' + e.message, 'error');
  }
}

// ============================================================
// DAILY PRODUCTION VIEW
// ============================================================
function renderDailyProductionView() {
  const apiKey = state.clockifyApiKey || state.integrations?.clockify?.apiKey;
  if (!apiKey) return `<div class="report-container"><div class="empty-state"><div class="empty-icon">💰</div><div>יש להגדיר מפתח API של Clockify בהגדרות תחילה</div></div></div>`;

  if (!state.dailyProdMonth) {
    const now = new Date();
    state.dailyProdMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }
  const [yr, mo] = state.dailyProdMonth.split('-').map(Number);
  const monthStart = new Date(yr, mo-1, 1);
  const monthEnd   = new Date(yr, mo, 0);
  const label = monthStart.toLocaleDateString('he-IL', { year:'numeric', month:'long' });
  const prevMonth = (() => { const d = new Date(yr, mo-2, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
  const nextMonth = (() => { const d = new Date(yr, mo,   1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();

  const key  = `dailyProd_${state.dailyProdMonth}`;
  const data = state[key];

  const navHtml = `<div class="report-range-nav" style="margin-bottom:16px">
      <button class="report-nav-btn" onclick="setDailyProdMonth('${prevMonth}')">&#x276F;</button>
      <span class="report-range-label">${label}</span>
      <button class="report-nav-btn" onclick="setDailyProdMonth('${nextMonth}')">&#x276E;</button>
    </div>`;

  if (data === undefined) {
    loadDailyProduction(yr, mo);
    return `<div class="report-container">${navHtml}<div class="empty-state"><div class="empty-icon">⏳</div><div>טוען נתונים...</div></div></div>`;
  }
  if (data === null) {
    return `<div class="report-container">${navHtml}<div class="empty-state"><div class="empty-icon">⏳</div><div>טוען נתונים...</div></div></div>`;
  }

  // Build calendar grid
  const daysInMonth = monthEnd.getDate();
  const firstDow    = monthStart.getDay(); // 0=Sun
  const todayStr    = new Date().toISOString().split('T')[0];

  let totalSecs = 0, billableSecs = 0, totalEarned = 0;
  let cells = '';

  for (let i = 0; i < firstDow; i++) cells += `<div class="dp-cell dp-cell-empty"></div>`;

  const maxDaySecs = Object.values(data).reduce((m, v) => {
    const s = typeof v === 'number' ? v : (v?.total || 0);
    return Math.max(m, s);
  }, 0);

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr  = `${yr}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const day      = data[dateStr] || { total: 0, billable: 0, earned: 0 };
    const daySecs  = typeof day === 'number' ? day      : (day.total    || 0);
    const dayBill  = typeof day === 'number' ? 0        : (day.billable || 0);
    const dayEarned = typeof day === 'number' ? 0       : (day.earned   || 0);
    totalSecs    += daySecs;
    billableSecs += dayBill;
    totalEarned  += dayEarned;
    const money     = dayEarned ? Math.round(dayEarned) : null;
    const alpha     = maxDaySecs > 0 && daySecs > 0 ? (0.08 + (daySecs / maxDaySecs) * 0.30).toFixed(2) : 0;
    const isWeekend = (() => { const dow = new Date(yr, mo-1, d).getDay(); return dow === 5 || dow === 6; })();
    cells += buildDpCell(d, dateStr, daySecs, dayBill, money, todayStr, isWeekend, alpha);
  }

  const effectiveRate = totalSecs > 0 && totalEarned ? (totalEarned / (totalSecs / 3600)).toFixed(0) : null;
  const rateHint = !totalEarned && billableSecs === 0
    ? `<div class="dp-rate-hint">לא נמצאו שעות לחיוב — הגדר תעריף ב-Clockify לפי לקוח/פרויקט</div>` : '';

  return `<div class="report-container">
    <div class="report-header">
      <h2 class="report-title">💰 ייצור יומי</h2>
      <button class="btn btn-secondary btn-sm" onclick="loadDailyProduction(${yr},${mo})">🔄 רענן</button>
    </div>
    ${navHtml}
    ${rateHint}
    <div class="dp-kpi-row">
      <div class="dp-kpi">
        <div class="dp-kpi-icon">⏱</div>
        <div class="dp-kpi-label">שעות תועדו</div>
        <div class="dp-kpi-value">${(totalSecs / 3600).toFixed(1)}</div>
        <div class="dp-kpi-sub">שעות</div>
      </div>
      <div class="dp-kpi dp-kpi-blue">
        <div class="dp-kpi-icon">💼</div>
        <div class="dp-kpi-label">שעות לחיוב</div>
        <div class="dp-kpi-value">${(billableSecs / 3600).toFixed(1)}</div>
        <div class="dp-kpi-sub">${totalSecs > 0 ? Math.round(billableSecs/totalSecs*100) + '%' : '—'} מהסה"כ</div>
      </div>
      <div class="dp-kpi dp-kpi-green ${!totalEarned ? 'dp-kpi-dim' : ''}">
        <div class="dp-kpi-icon">💰</div>
        <div class="dp-kpi-label">הכנסה חודשית</div>
        <div class="dp-kpi-value">${totalEarned ? `₪${Math.round(totalEarned).toLocaleString()}` : '—'}</div>
        <div class="dp-kpi-sub">לפי תעריף Clockify</div>
      </div>
      <div class="dp-kpi ${!effectiveRate ? 'dp-kpi-dim' : ''}">
        <div class="dp-kpi-icon">📈</div>
        <div class="dp-kpi-label">₪ לשעת עבודה</div>
        <div class="dp-kpi-value">${effectiveRate ? `₪${effectiveRate}` : '—'}</div>
        <div class="dp-kpi-sub">כולל שעות לא לחיוב</div>
      </div>
    </div>
    <div class="dp-dow-headers">
      <div>א'</div><div>ב'</div><div>ג'</div><div>ד'</div><div>ה'</div><div>ו'</div><div>ש'</div>
    </div>
    <div class="dp-grid">${cells}</div>
  </div>`;
}

function setDailyProdMonth(ym) {
  state.dailyProdMonth = ym;
  renderMain();
}

async function loadDailyProduction(yr, mo) {
  const apiKey = state.clockifyApiKey || state.integrations?.clockify?.apiKey;
  const wsId   = CLOCKIFY_WORKSPACE;
  const start  = new Date(yr, mo-1, 1).toISOString();
  const end    = new Date(yr, mo,   0, 23, 59, 59, 999).toISOString();
  const key    = `dailyProd_${yr}-${String(mo).padStart(2,'0')}`;
  state[key]   = null;
  renderMain();
  try {
    // Use Detailed Reports API — returns billableAmount per entry based on Clockify rates
    let page = 1, allEntries = [];
    while (true) {
      const res = await fetch(
        `https://reports.api.clockify.me/v1/workspaces/${wsId}/reports/detailed`,
        {
          method: 'POST',
          headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dateRangeStart: start,
            dateRangeEnd:   end,
            dateRangeType:  'ABSOLUTE',
            detailedFilter: { page, pageSize: 200, options: { totals: 'CALCULATE' } }
          })
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
      const data    = await res.json();
      const entries = data.timeentries || data.timeEntries || [];
      allEntries.push(...entries);
      if (entries.length < 200) break;
      page++;
    }
    const map = {};
    for (const e of allEntries) {
      const dateStr = (e.timeInterval?.start || e.startTime || '').split('T')[0];
      if (!dateStr) continue;
      const secs    = e.timeInterval?.duration != null
        ? e.timeInterval.duration
        : ((new Date(e.timeInterval?.end || e.endTime) - new Date(e.timeInterval?.start || e.startTime)) / 1000);
      const earned  = e.billableAmount || 0;   // ₪ already calculated by Clockify
      if (!map[dateStr]) map[dateStr] = { total: 0, billable: 0, earned: 0 };
      map[dateStr].total    += secs;
      map[dateStr].billable += e.billable ? secs : 0;
      map[dateStr].earned   += earned;
    }
    state[key] = map;
  } catch(err) {
    showToast('שגיאה בטעינת נתוני ייצור: ' + err.message, 'error');
    state[key] = {};
  }
  renderMain();
}

// ============================================================
// DAILY LOCAL PRODUCTION VIEW
// ============================================================
function buildLocalDailyMap() {
  // Returns { dateStr: { total: secs, billable: secs, earned: money } }
  const map = {};
  const defaultRate = parseFloat(state.business?.hourlyRate || 0);
  for (const c of state.clients) {
    const clientRate = parseFloat(c.defaultHourlyRate || 0) || defaultRate;
    for (const p of (c.projects || [])) {
      const rate = parseFloat(p.hourlyRate || 0) || clientRate;
      const isBillable = !!p.billable;
      // tasks
      for (const t of (p.tasks || [])) {
        for (const e of (t.timeEntries || [])) {
          if (!e.date || !e.seconds) continue;
          if (!map[e.date]) map[e.date] = { total: 0, billable: 0, earned: 0 };
          map[e.date].total += e.seconds;
          if (isBillable) {
            map[e.date].billable += e.seconds;
            map[e.date].earned  += (e.seconds / 3600) * rate;
          }
        }
        // subtasks
        for (const s of (t.subtasks || [])) {
          for (const e of (s.timeEntries || [])) {
            if (!e.date || !e.seconds) continue;
            if (!map[e.date]) map[e.date] = { total: 0, billable: 0, earned: 0 };
            map[e.date].total += e.seconds;
            if (isBillable) {
              map[e.date].billable += e.seconds;
              map[e.date].earned  += (e.seconds / 3600) * rate;
            }
          }
        }
      }
    }
  }
  return map;
}

function renderDailyLocalView() {
  if (!state.dailyLocalMonth) {
    const now = new Date();
    state.dailyLocalMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }
  const [yr, mo] = state.dailyLocalMonth.split('-').map(Number);
  const monthStart = new Date(yr, mo-1, 1);
  const monthEnd   = new Date(yr, mo, 0);
  const label      = monthStart.toLocaleDateString('he-IL', { year:'numeric', month:'long' });
  const prevMonth  = (() => { const d = new Date(yr, mo-2, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
  const nextMonth  = (() => { const d = new Date(yr, mo,   1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();

  const allData   = buildLocalDailyMap();
  const defaultRate = parseFloat(state.business?.hourlyRate || 0);

  const navHtml = `<div class="report-range-nav" style="margin-bottom:16px">
    <button class="report-nav-btn" onclick="setDailyLocalMonth('${prevMonth}')">&#x276F;</button>
    <span class="report-range-label">${label}</span>
    <button class="report-nav-btn" onclick="setDailyLocalMonth('${nextMonth}')">&#x276E;</button>
  </div>`;

  const daysInMonth = monthEnd.getDate();
  const firstDow    = monthStart.getDay();
  const todayStr    = new Date().toISOString().split('T')[0];
  const prefix      = `${yr}-${String(mo).padStart(2,'0')}`;

  // KPI totals for the month
  let totalSecs = 0, billableSecs = 0, totalEarned = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${prefix}-${String(d).padStart(2,'0')}`;
    const day = allData[ds];
    if (!day) continue;
    totalSecs    += day.total;
    billableSecs += day.billable;
    totalEarned  += day.earned;
  }

  const effectiveRate = totalSecs > 0 && totalEarned
    ? (totalEarned / (totalSecs / 3600)).toFixed(0) : null;
  const rateHint = !defaultRate && billableSecs === 0
    ? `<div class="dp-rate-hint">הגדר תעריף שעתי בהגדרות → עסק, או ברמת פרויקט, כדי לראות הכנסות</div>` : '';

  // Heat-map max
  const maxSecs = Object.values(allData).reduce((m, v) => Math.max(m, v.total), 0);

  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += `<div class="dp-cell dp-cell-empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr  = `${prefix}-${String(d).padStart(2,'0')}`;
    const day      = allData[dateStr] || { total: 0, billable: 0, earned: 0 };
    const daySecs  = day.total;
    const dayBill  = day.billable;
    const dayMoney = day.earned ? Math.round(day.earned) : null;
    const alpha    = maxSecs > 0 && daySecs > 0 ? (0.08 + (daySecs / maxSecs) * 0.30).toFixed(2) : 0;
    const isWeekend = (() => { const dow = new Date(yr, mo-1, d).getDay(); return dow === 5 || dow === 6; })();

    cells += buildDpCell(d, dateStr, daySecs, dayBill, dayMoney, todayStr, isWeekend, alpha);
  }

  return `<div class="report-container">
    <div class="report-header">
      <h2 class="report-title">📋 ייצור יומי מקומי</h2>
    </div>
    ${navHtml}
    ${rateHint}
    <div class="dp-kpi-row">
      <div class="dp-kpi">
        <div class="dp-kpi-icon">⏱</div>
        <div class="dp-kpi-label">שעות תועדו</div>
        <div class="dp-kpi-value">${(totalSecs / 3600).toFixed(1)}</div>
        <div class="dp-kpi-sub">שעות</div>
      </div>
      <div class="dp-kpi dp-kpi-blue">
        <div class="dp-kpi-icon">💼</div>
        <div class="dp-kpi-label">שעות לחיוב</div>
        <div class="dp-kpi-value">${(billableSecs / 3600).toFixed(1)}</div>
        <div class="dp-kpi-sub">${totalSecs > 0 ? Math.round(billableSecs/totalSecs*100) + '%' : '—'} מהסה"כ</div>
      </div>
      <div class="dp-kpi dp-kpi-green ${!totalEarned ? 'dp-kpi-dim' : ''}">
        <div class="dp-kpi-icon">💰</div>
        <div class="dp-kpi-label">הכנסה חודשית</div>
        <div class="dp-kpi-value">${totalEarned ? `₪${Math.round(totalEarned).toLocaleString()}` : '—'}</div>
        <div class="dp-kpi-sub">${defaultRate ? `תעריף ₪${defaultRate}/ש` : 'לפי תעריף פרויקט'}</div>
      </div>
      <div class="dp-kpi ${!effectiveRate ? 'dp-kpi-dim' : ''}">
        <div class="dp-kpi-icon">📈</div>
        <div class="dp-kpi-label">₪ לשעת עבודה</div>
        <div class="dp-kpi-value">${effectiveRate ? `₪${effectiveRate}` : '—'}</div>
        <div class="dp-kpi-sub">כולל שעות לא לחיוב</div>
      </div>
    </div>
    <div class="dp-dow-headers">
      <div>א'</div><div>ב'</div><div>ג'</div><div>ד'</div><div>ה'</div><div>ו'</div><div>ש'</div>
    </div>
    <div class="dp-grid">${cells}</div>
  </div>`;
}

function setDailyLocalMonth(ym) {
  state.dailyLocalMonth = ym;
  renderMain();
}

function buildDpCell(d, dateStr, daySecs, dayBill, dayMoney, todayStr, isWeekend, alpha) {
  const isToday = dateStr === todayStr;
  const dayRate = daySecs > 0 && dayMoney ? Math.round(dayMoney / (daySecs / 3600)) : null;
  const bgStyle = daySecs > 0
    ? `background:rgba(99,102,241,${alpha});border-color:rgba(99,102,241,${Math.min(1, +alpha + 0.15)})`
    : '';
  const stats = daySecs ? `
    <div class="dp-stats">
      <div class="dp-stat-row"><span class="dp-stat-label">תועדו</span><span class="dp-stat-val clr-hours">${formatTime(daySecs)}</span></div>
      <div class="dp-stat-row"><span class="dp-stat-label">לחיוב</span><span class="dp-stat-val clr-bill">${formatTime(dayBill)}</span></div>
      <div class="dp-stat-row"><span class="dp-stat-label">הכנסה</span><span class="dp-stat-val clr-money">${dayMoney ? '₪' + dayMoney : '—'}</span></div>
      <div class="dp-stat-row"><span class="dp-stat-label">₪/שעה</span><span class="dp-stat-val clr-rate">${dayRate ? '₪' + dayRate : '—'}</span></div>
    </div>` : '';
  return `<div class="dp-cell ${isToday ? 'dp-cell-today' : ''} ${isWeekend ? 'dp-cell-weekend' : ''}" style="${bgStyle}">
    <span class="dp-day-num">${d}</span>${stats}
  </div>`;
}

function setSettingsSection(key) {
  state.settingsSection = key;
  saveState(); renderMain();
}

function renderSettingsView() {
  const section = state.settingsSection || 'business';
  const b  = state.business     || {};
  const ci  = (state.integrations || {}).clockify   || {};
  const gi  = (state.integrations || {}).greenapi   || {};
  const ai  = (state.integrations || {}).accounting || {};
  const cli = (state.integrations || {}).claude     || {};

  // ---- Sidebar nav ----
  let navHtml = '';
  for (const s of SETTINGS_SECTIONS) {
    if (s.header) {
      navHtml += `<div class="settings-nav-header">${s.label}</div>`;
      continue;
    }
    navHtml += `<button class="settings-nav-item ${section === s.key ? 'active' : ''}"
      onclick="setSettingsSection('${s.key}')">${s.icon} ${s.label}</button>`;
  }

  // ---- Section content ----
  let content = '';

  if (section === 'business') {
    content = `
      <div class="settings-section-title">🏢 פרטי עסק</div>
      <div class="settings-card">
        <div class="settings-grid">
          <div class="settings-field">
            <label>שם העסק</label>
            <input id="s-biz-name" class="settings-input" value="${esc(b.name||'')}" placeholder="שם העסק שלך">
          </div>
          <div class="settings-field">
            <label>תיאור קצר</label>
            <input id="s-biz-tagline" class="settings-input" value="${esc(b.tagline||'')}" placeholder="מה אתה עושה?">
          </div>
          <div class="settings-field">
            <label>אימייל</label>
            <input id="s-biz-email" class="settings-input" type="email" value="${esc(b.email||'')}" placeholder="info@example.com">
          </div>
          <div class="settings-field">
            <label>טלפון</label>
            <input id="s-biz-phone" class="settings-input" value="${esc(b.phone||'')}" placeholder="050-0000000">
          </div>
          <div class="settings-field">
            <label>כתובת</label>
            <input id="s-biz-address" class="settings-input" value="${esc(b.address||'')}" placeholder="רחוב, עיר">
          </div>
          <div class="settings-field">
            <label>ח.פ / ע.מ</label>
            <input id="s-biz-taxid" class="settings-input" value="${esc(b.taxId||'')}" placeholder="מספר עוסק">
          </div>
          <div class="settings-field">
            <label>אתר אינטרנט</label>
            <input id="s-biz-website" class="settings-input" value="${esc(b.website||'')}" placeholder="https://...">
          </div>
          <div class="settings-field">
            <label>לוגו (URL תמונה)</label>
            <input id="s-biz-logo" class="settings-input" value="${esc(b.logoUrl||'')}" placeholder="https://...">
          </div>
          <div class="settings-field">
            <label>תעריף שעתי (₪)</label>
            <input id="s-biz-rate" class="settings-input" type="number" min="0" value="${esc(b.hourlyRate||'')}" placeholder="0">
          </div>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="saveBusinessSettings()">💾 שמור שינויים</button>
      </div>`;
  }

  else if (section === 'backup') {
    const lastBackup  = state._lastManualBackup ? new Date(state._lastManualBackup).toLocaleString('he-IL') : 'לא בוצע עדיין';
    const clientCount = (state.clients || []).filter(c => !c.archived).length;
    const taskCount   = (state.clients || []).reduce((n, c) => n + (c.projects || []).reduce((m, p) => m + (p.tasks || []).length, 0), 0);
    content = `
      <div class="settings-section-title">💾 גיבוי ושחזור</div>
      <div class="settings-card">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
          מצב נוכחי: <strong style="color:var(--text)">${clientCount} לקוחות, ${taskCount} משימות</strong>
          &nbsp;·&nbsp; גיבוי אחרון: <strong style="color:var(--text)">${lastBackup}</strong>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="settings-card" style="margin:0;padding:16px">
            <div style="font-weight:600;margin-bottom:6px">📤 ייצוא גיבוי</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">מוריד קובץ JSON עם כל הנתונים — לקוחות, פרויקטים, משימות, הגדרות</div>
            <button class="btn btn-primary" onclick="exportBackup()">⬇ הורד גיבוי עכשיו</button>
          </div>
          <div class="settings-card" style="margin:0;padding:16px">
            <div style="font-weight:600;margin-bottom:6px">📥 ייבוא גיבוי</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">שחזור מקובץ JSON שיוצא קודם — <strong>ידרוס את כל הנתונים הנוכחיים</strong></div>
            <label class="btn btn-ghost" style="cursor:pointer">
              ⬆ בחר קובץ גיבוי
              <input type="file" accept=".json" style="display:none" onchange="importBackup(this)">
            </label>
          </div>
        </div>
      </div>
      <div class="settings-card" style="background:#fffbeb;border-color:#fde68a">
        <div style="font-size:13px;color:#92400e">
          <strong>💡 טיפ:</strong> ייצא גיבוי לאחר כל יום עבודה ושמור בתיקיית OneDrive / Google Drive להגנה מקסימלית.
        </div>
      </div>`;
  }

  else if (section === 'clockify') {
    const connected = !!(ci.apiKey || state.clockifyApiKey);
    content = `
      <div class="settings-section-title">⏱ Clockify</div>
      <div class="settings-integration-hero ${connected ? 'connected' : ''}">
        <div class="integration-logo">⏱</div>
        <div class="integration-hero-info">
          <div class="integration-hero-name">Clockify</div>
          <div class="integration-hero-desc">מעקב זמן ושעות עבודה — סנכרון אוטומטי בהפעלת שעון</div>
        </div>
        <span class="integration-status-badge ${connected ? 'on' : 'off'}">${connected ? '● מחובר' : '○ לא מחובר'}</span>
      </div>
      <div class="settings-card">
        <div class="settings-grid">
          <div class="settings-field settings-field-full">
            <label>API Key</label>
            <input id="s-ck-apikey" class="settings-input" value="${esc(ci.apiKey || state.clockifyApiKey || '')}" placeholder="הדבק את מפתח ה-API">
            <span class="settings-hint">נמצא בהגדרות הפרופיל שלך ב-Clockify &rarr; Profile Settings &rarr; API</span>
          </div>
          <div class="settings-field">
            <label>Workspace ID</label>
            <input id="s-ck-wsid" class="settings-input" value="${esc(ci.workspaceId || CLOCKIFY_WORKSPACE)}" placeholder="Workspace ID">
          </div>
          <div class="settings-field">
            <label>User ID</label>
            <input id="s-ck-uid" class="settings-input" value="${esc(ci.userId || CLOCKIFY_USER_ID)}" placeholder="User ID">
          </div>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="saveClockifySettings()">💾 שמור</button>
      </div>`;
  }

  else if (section === 'claude') {
    const connected = !!cli.apiKey;
    content = `
      <div class="settings-section-title">🤖 Claude AI</div>
      <div class="settings-integration-hero ${connected ? 'connected' : ''}">
        <div class="integration-logo">🤖</div>
        <div class="integration-hero-info">
          <div class="integration-hero-name">Claude AI (Anthropic)</div>
          <div class="integration-hero-desc">יצירת שמות חכמים למשימות — הקלד תוכן ולחץ Shift+Enter</div>
        </div>
        <span class="integration-status-badge ${connected ? 'on' : 'off'}">${connected ? '● מחובר' : '○ לא מחובר'}</span>
      </div>
      <div class="settings-card">
        <div class="settings-grid">
          <div class="settings-field settings-field-full">
            <label>API Key</label>
            <input id="s-claude-apikey" class="settings-input" type="password" value="${esc(cli.apiKey || '')}" placeholder="sk-ant-...">
            <span class="settings-hint">נמצא בדשבורד Anthropic &rarr; console.anthropic.com &rarr; API Keys</span>
          </div>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="saveClaudeSettings()">💾 שמור</button>
      </div>`;
  }

  else if (section === 'greenapi') {
    content = `
      <div class="settings-section-title">💬 Green API — WhatsApp</div>
      <div class="settings-integration-hero">
        <div class="integration-logo">💬</div>
        <div class="integration-hero-info">
          <div class="integration-hero-name">Green API</div>
          <div class="integration-hero-desc">שליחת עדכונים ותזכורות ללקוחות דרך WhatsApp</div>
        </div>
        <span class="integration-status-badge off">○ בקרוב</span>
      </div>
      <div class="settings-coming-soon">
        <div class="coming-soon-icon">🚧</div>
        <div class="coming-soon-title">בפיתוח</div>
        <div class="coming-soon-desc">אינטגרציה עם Green API תאפשר שליחת הודעות WhatsApp אוטומטיות ללקוחות</div>
      </div>`;
  }

  else if (section === 'accounting') {
    content = `
      <div class="settings-section-title">📒 חשבונאות</div>
      <div class="settings-integration-hero">
        <div class="integration-logo">📒</div>
        <div class="integration-hero-info">
          <div class="integration-hero-name">חשבונאות</div>
          <div class="integration-hero-desc">חיבור לתוכנת חשבונאות — הפקת חשבוניות אוטומטיות</div>
        </div>
        <span class="integration-status-badge off">○ בקרוב</span>
      </div>
      <div class="settings-coming-soon">
        <div class="coming-soon-icon">🚧</div>
        <div class="coming-soon-title">בפיתוח</div>
        <div class="coming-soon-desc">תמיכה ב-חשבשבת, Priority, ו-iCount — הפקת חשבוניות ישירות ממסך הלקוח</div>
      </div>`;
  }

  return `<div class="settings-layout">
    <nav class="settings-nav">${navHtml}</nav>
    <div class="settings-content">${content}</div>
  </div>`;
}

function saveBusinessSettings() {
  state.business = {
    name:    document.getElementById('s-biz-name')?.value    || '',
    tagline: document.getElementById('s-biz-tagline')?.value || '',
    email:   document.getElementById('s-biz-email')?.value   || '',
    phone:   document.getElementById('s-biz-phone')?.value   || '',
    address: document.getElementById('s-biz-address')?.value || '',
    taxId:   document.getElementById('s-biz-taxid')?.value   || '',
    website: document.getElementById('s-biz-website')?.value || '',
    logoUrl:    document.getElementById('s-biz-logo')?.value    || '',
    hourlyRate: document.getElementById('s-biz-rate')?.value    || '',
  };
  saveState();
  showToast('פרטי עסק נשמרו ✓', 'success');
}

function saveClockifySettings() {
  const apiKey = document.getElementById('s-ck-apikey')?.value || '';
  const wsId   = document.getElementById('s-ck-wsid')?.value   || '';
  const uid    = document.getElementById('s-ck-uid')?.value    || '';
  state.clockifyApiKey = apiKey;
  if (!state.integrations) state.integrations = {};
  if (!state.integrations.clockify) state.integrations.clockify = {};
  state.integrations.clockify.apiKey      = apiKey;
  state.integrations.clockify.workspaceId = wsId;
  state.integrations.clockify.userId      = uid;
  saveState();
  showToast('הגדרות Clockify נשמרו ✓', 'success');
  renderMain();
}

// ============================================================
// BACKUP / RESTORE
// ============================================================
function exportBackup() {
  const now     = new Date();
  const pad     = n => String(n).padStart(2, '0');
  const stamp   = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const data    = JSON.stringify(state, null, 2);
  const blob    = new Blob([data], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href        = url;
  a.download    = `taskmanager_backup_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  state._lastManualBackup = Date.now();
  saveState();
  showToast('גיבוי הורד בהצלחה ✓', 'success');
  renderMain();
}

function importBackup(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const saved = JSON.parse(e.target.result);
      if (!saved.clients) { showToast('קובץ לא תקין — חסר שדה clients', 'error'); return; }
      if (!confirm(`ייבוא יחליף את כל הנתונים הנוכחיים.\n${saved.clients.length} לקוחות בקובץ.\nלהמשיך?`)) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      loadState();
      render();
      showToast(`יובאו ${saved.clients.length} לקוחות בהצלחה ✓`, 'success');
    } catch(err) {
      showToast('שגיאה בקריאת הקובץ', 'error');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

function saveClaudeSettings() {
  const apiKey = document.getElementById('s-claude-apikey')?.value?.trim() || '';
  if (!state.integrations) state.integrations = {};
  if (!state.integrations.claude) state.integrations.claude = {};
  state.integrations.claude.apiKey = apiKey;
  saveState();
  showToast('הגדרות Claude AI נשמרו ✓', 'success');
  renderMain();
}

async function callClaudeApi(description) {
  const apiKey = state.integrations?.claude?.apiKey;
  if (!apiKey) return null;
  try {
    const resp = await fetch('/.netlify/functions/claude', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        system: 'אתה מחולל כותרות קצרות למשימות בעברית. הכלל: החזר 3-5 מילים בלבד — ללא פסיק, ללא נקודה, ללא הסבר, ללא markdown, ללא #, ללא כוכביות. מילים בלבד.',
        messages: [{ role: 'user', content: description }]
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('Claude API error:', resp.status, err);
      showToast(`שגיאת Claude API: ${resp.status}`, 'error');
      return null;
    }
    const data = await resp.json();
    const raw = data.content?.[0]?.text?.trim() || null;
    if (!raw) return null;
    // Strip markdown symbols and clean up
    const title = raw.replace(/^#+\s*/g, '').replace(/[*_`]/g, '').trim();
    // Guard: if the model returned the full description, discard it
    if (title && title.split(' ').length <= 8) return title;
    return null;
  } catch (err) {
    console.error('Claude fetch error:', err);
    showToast('לא ניתן לגשת ל-Claude API — בדוק חיבור ומפתח', 'error');
    return null;
  }
}

async function quickAddWithAI() {
  const apiKey = state.integrations?.claude?.apiKey;
  if (!apiKey) {
    showToast('הגדר Claude API key בהגדרות → Claude AI', 'error');
    return;
  }

  const input = document.getElementById('quick-add-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const { title: description, projectName, tags, dueDate } = parseQuickInput(text);
  if (!description) { showToast('הכנס תוכן למשימה', 'error'); return; }

  input.disabled = true;
  const origPlaceholder = input.placeholder;
  input.placeholder = '✨ AI מייצר שם...';

  try {
    const aiTitle = await callClaudeApi(description);
    if (!aiTitle) return; // error already shown by callClaudeApi
    const title = aiTitle;

    let cid, pid;
    if (projectName) {
      const found = findProjectByName(projectName);
      if (!found) {
        _aiTaskDescription = description;
        showQuickProjectModal(title, tags, dueDate, projectName);
        return;
      }
      cid = found.cid; pid = found.pid;
    } else if (state.currentView === 'project' && state.selectedClientId && state.selectedProjectId) {
      cid = state.selectedClientId; pid = state.selectedProjectId;
    } else {
      _aiTaskDescription = description;
      showQuickProjectModal(title, tags, dueDate, '');
      return;
    }

    addTask(cid, pid, { title, description, tags, dueDate });
    input.value = '';
    document.getElementById('quick-add-preview').innerHTML = '';
    document.getElementById('quick-suggestions')?.classList.remove('open');

    if (state.currentView !== 'project' || state.selectedProjectId !== pid) {
      state.selectedClientId = cid; state.selectedProjectId = pid;
      state.currentView = 'project'; state.filters.status = STATUS.OPEN;
      saveState();
    }
    render();
    showToast(`✨ "${title}"`, 'success');
  } finally {
    input.disabled = false;
    input.placeholder = origPlaceholder;
    input.focus();
  }
}

// ============================================================
// MODAL — SETTINGS (legacy, kept for compatibility)
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
// DRAG & DROP — task reordering
// ============================================================
let _drag = null; // { taskId, clientId, projectId }

document.addEventListener('dragstart', e => {
  const card = e.target.closest('[data-task-id]');
  if (!card) return;
  _drag = { taskId: card.dataset.taskId, clientId: card.dataset.clientId, projectId: card.dataset.projectId };
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

document.addEventListener('dragend', e => {
  document.querySelectorAll('.task-card.dragging, .task-card.drag-over-top, .task-card.drag-over-bot').forEach(el => {
    el.classList.remove('dragging', 'drag-over-top', 'drag-over-bot');
  });
  _drag = null;
});

document.addEventListener('dragover', e => {
  const card = e.target.closest('[data-task-id]');
  if (!card || !_drag) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const rect = card.getBoundingClientRect();
  const insertBefore = e.clientY < rect.top + rect.height / 2;
  card.classList.toggle('drag-over-top', insertBefore);
  card.classList.toggle('drag-over-bot', !insertBefore);
});

document.addEventListener('dragleave', e => {
  const card = e.target.closest('[data-task-id]');
  if (card) card.classList.remove('drag-over-top', 'drag-over-bot');
});

document.addEventListener('drop', e => {
  const card = e.target.closest('[data-task-id]');
  if (!card || !_drag) return;
  e.preventDefault();
  const toTaskId = card.dataset.taskId;
  const rect = card.getBoundingClientRect();
  const insertBefore = e.clientY < rect.top + rect.height / 2;
  reorderTask(_drag.taskId, _drag.clientId, _drag.projectId, toTaskId, insertBefore);
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
        placeholder="הוסף משימה... #פרויקט @תגית $מחר | Shift+Enter = ✨ AI שם"
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
    } else if (e.shiftKey) {
      quickAddWithAI();
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
  const description = _aiTaskDescription || '';
  _aiTaskDescription = null;

  const existingTab = document.getElementById('qtab-existing');
  const useExisting = existingTab && existingTab.style.display !== 'none';

  if (useExisting) {
    const val = document.getElementById('f-existing-proj')?.value;
    if (!val) { showToast('בחר פרויקט', 'error'); return; }
    const [cid, pid] = val.split('|');
    addTask(cid, pid, { title: taskTitle, description, tags, dueDate });
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
    addTask(cid, p.id, { title: taskTitle, description, tags, dueDate });
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
  state.currentView = 'project'; state.filters.status = STATUS.OPEN;
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
    state.filters.status = STATUS.OPEN;
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
  initSupabase();
  loadState();
  render();
  syncFromSupabase(); // async — updates state & re-renders when Supabase data arrives
  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.quick-add-wrap')) {
      document.getElementById('quick-suggestions')?.classList.remove('open');
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
