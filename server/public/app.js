const CATEGORIES = {
  hate: { label: 'Hate', cls: 'bg-red-100 text-red-800' },
  harassment: { label: 'Harassment', cls: 'bg-orange-100 text-orange-800' },
  threat: { label: 'Threat', cls: 'bg-red-100 text-red-800' },
  spam: { label: 'Spam', cls: 'bg-amber-100 text-amber-800' },
  scam_accusation: { label: 'Scam accusation', cls: 'bg-fuchsia-100 text-fuchsia-800' },
  ai_accusation: { label: 'AI accusation', cls: 'bg-violet-100 text-violet-800' },
  fake_accusation: { label: 'Fake accusation', cls: 'bg-purple-100 text-purple-800' },
  negative_criticism: { label: 'Criticism', cls: 'bg-slate-200 text-slate-700' },
  safe: { label: 'Safe', cls: 'bg-emerald-100 text-emerald-800' },
};

const FILTERS = [
  { key: 'flagged', label: 'Needs attention', hint: 'AI suggests delete or review, still visible' },
  { key: 'unanswered', label: 'Unanswered', hint: 'Safe top-level comments without a Page reply' },
  { key: 'all', label: 'All comments', hint: '' },
  { key: 'hidden', label: 'Hidden', hint: '' },
  { key: 'deleted', label: 'Deleted', hint: '' },
  { key: 'unreviewed', label: 'Not reviewed yet', hint: 'Waiting for AI review' },
];

const AUTOMOD_STATUS = {
  deleted: { label: 'Auto-deleted', cls: 'bg-red-50 text-red-700 ring-red-200' },
  hidden: { label: 'Auto-hidden', cls: 'bg-amber-50 text-amber-700 ring-amber-200' },
  would_delete: { label: 'Would delete (dry run)', cls: 'bg-slate-50 text-slate-600 ring-slate-200' },
  would_hide: { label: 'Would hide (dry run)', cls: 'bg-slate-50 text-slate-600 ring-slate-200' },
  failed: { label: 'Auto-action failed', cls: 'bg-red-50 text-red-700 ring-red-200' },
};

function app() {
  return {
    tab: 'comments',
    now: Date.now(),
    state: null,
    toasts: [],

    // comments
    filters: FILTERS,
    filter: 'flagged',
    postFilter: '',
    q: '',
    rows: [],
    total: 0,
    counts: {},
    offset: 0,
    limit: 50,
    loadingComments: false,
    selected: [],
    busyIds: {},
    replyOpen: null,
    replyText: '',
    replyBusy: false,

    // posts
    posts: [],
    trackedDraft: {},
    postView: 'all',
    postQuery: '',
    addInput: '',
    addBusy: false,
    discovering: false,
    savingTracked: false,

    // activity
    runs: [],
    openRunId: null,
    runActions: {},
    recentActions: [],

    // settings
    settingsDraft: null,
    savingSettings: false,
    blocked: [],

    categories: CATEGORIES,

    async init() {
      const t = new URLSearchParams(location.hash.slice(1)).get('tab');
      if (['comments', 'posts', 'activity', 'settings'].includes(t)) this.tab = t;
      await this.loadState();
      await this.loadPosts();
      this.go(this.tab);
      setInterval(() => { this.now = Date.now(); }, 1000);
      this.poll();
    },

    // Polls quickly while a run is in progress, slowly otherwise.
    async poll() {
      const wasRunning = this.state?.scheduler?.running;
      await this.loadState();
      const running = this.state?.scheduler?.running;
      if (wasRunning && !running) {
        this.toast(this.runSummary(this.state.lastRun), this.state.lastRun?.status === 'error' ? 'error' : 'ok');
        this.loadComments();
        if (this.tab === 'activity') this.loadActivity();
      }
      setTimeout(() => this.poll(), running ? 2500 : 30000);
    },

    go(tab) {
      this.tab = tab;
      history.replaceState(null, '', `#tab=${tab}`);
      if (tab === 'activity') this.loadActivity();
      if (tab === 'settings') { this.settingsDraft = JSON.parse(JSON.stringify(this.state.settings)); this.loadBlocked(); }
      if (tab === 'posts') this.loadPosts();
      if (tab === 'comments') this.loadComments();
    },

    async api(path, opts = {}) {
      const init = { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } };
      if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
      try {
        const res = await fetch(path, init);
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok && data.ok !== false, status: res.status, data };
      } catch (err) {
        return { ok: false, status: 0, data: { message: String(err) } };
      }
    },

    toast(message, kind = 'ok') {
      const id = Math.random();
      this.toasts.push({ id, message, kind });
      setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); }, kind === 'error' ? 8000 : 4500);
    },

    // ---------- state ----------

    async loadState() {
      const { ok, data } = await this.api('/api/state');
      if (ok) { this.state = data; this.counts = data.counts; }
    },

    get status() {
      const s = this.state;
      if (!s) return { label: 'Loading…', dot: 'bg-slate-300', tone: 'text-slate-500' };
      if (s.safety.killSwitch) return { label: 'Kill switch on', dot: 'bg-red-500', tone: 'text-red-700' };
      if (s.scheduler.running) return { label: 'Running now…', dot: 'bg-blue-500 animate-pulse', tone: 'text-blue-700' };
      if (!s.settings.enabled) return { label: 'Automation off', dot: 'bg-slate-400', tone: 'text-slate-600' };
      if (s.settings.dryRun) return { label: 'Dry run', dot: 'bg-amber-500', tone: 'text-amber-700' };
      return { label: 'Active', dot: 'bg-emerald-500', tone: 'text-emerald-700' };
    },

    get warnings() {
      const s = this.state;
      if (!s) return [];
      const w = [];
      if (!s.safety.moderationAllowed) w.push('FB_ALLOW_COMMENT_MODERATION is off — comments are reviewed but nothing is hidden or deleted.');
      if (!s.analyzerEnabled) w.push('OPENROUTER_API_KEY is missing — comments cannot be reviewed, so the automation takes no action.');
      if (!s.trackedPosts) w.push('No posts are tracked yet. Choose posts in the Posts tab.');
      return w;
    },

    get nextRunLabel() {
      const at = this.state?.scheduler?.nextRunAt;
      if (!at) return null;
      const s = Math.max(0, Math.round((Date.parse(at) - this.now) / 1000));
      const m = Math.floor(s / 60);
      return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
    },

    async runNow() {
      const { ok, data } = await this.api('/api/run', { method: 'POST' });
      if (!ok) return this.toast(data.message || 'Could not start a run.', 'error');
      this.toast('Run started — fetching new comments…');
      await this.loadState();
      setTimeout(() => this.poll(), 1500);
    },

    runSummary(r) {
      if (!r) return 'Run finished.';
      if (r.status === 'error') return `Run failed: ${r.error || 'unknown error'}`;
      const parts = [`${r.new_comments} new comment${r.new_comments === 1 ? '' : 's'}`, `${r.analyzed} reviewed`];
      if (r.deleted) parts.push(`${r.deleted} deleted`);
      if (r.hidden) parts.push(`${r.hidden} hidden`);
      if (r.dry_run) parts.push('dry run');
      return `Run finished: ${parts.join(' · ')}`;
    },

    // ---------- comments ----------

    async loadComments(reset = true) {
      if (reset) { this.offset = 0; this.selected = []; }
      this.loadingComments = true;
      const p = new URLSearchParams({ filter: this.filter, limit: this.limit, offset: this.offset });
      if (this.postFilter) p.set('post_id', this.postFilter);
      if (this.q) p.set('q', this.q);
      const { ok, data } = await this.api(`/api/comments?${p}`);
      this.loadingComments = false;
      if (!ok) return this.toast(data.message || 'Could not load comments.', 'error');
      this.rows = data.rows;
      this.total = data.total;
      this.counts = data.counts;
    },

    setFilter(key) { this.filter = key; this.loadComments(); },
    page(dir) { this.offset = Math.max(0, this.offset + dir * this.limit); this.loadComments(false); },

    get trackedPosts() { return this.posts.filter((p) => p.tracked); },

    patchRow(c) {
      const i = this.rows.findIndex((r) => r.id === c.id);
      if (i !== -1) this.rows[i] = { ...this.rows[i], ...c };
    },

    // Fades the card out, then drops it from the list.
    removeRow(id) {
      const row = this.rows.find((r) => r.id === id);
      if (row) row._leaving = true;
      this.selected = this.selected.filter((x) => x !== id);
      setTimeout(() => {
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => r.id !== id);
        this.total = Math.max(0, this.total - (before - this.rows.length));
      }, 280);
    },

    // After a successful action, drop the card if it no longer belongs in the current filter.
    leavesFilter(action) {
      if (action === 'delete') return true;
      if (action === 'hide') return ['flagged', 'unanswered'].includes(this.filter);
      if (action === 'unhide') return this.filter === 'hidden';
      if (action === 'block') return false;
      return false;
    },

    async applyAction(id, action) {
      this.busyIds[id] = action;
      const res = await this.api(`/api/comments/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      delete this.busyIds[id];
      if (res.ok) {
        if (this.leavesFilter(action)) this.removeRow(id);
        else if (res.data.comment) this.patchRow(res.data.comment);
      }
      return res;
    },

    async act(row, action) {
      const labels = { delete: 'Delete this comment permanently?', block: `Block ${row.from_name || 'this person'} from the Page?` };
      if (labels[action] && !confirm(labels[action])) return;
      const { ok, data } = await this.applyAction(row.id, action);
      if (!ok) return this.toast(data.message || `${action} failed.`, 'error');
      this.toast({ hide: 'Hidden', unhide: 'Visible again', delete: 'Deleted', like: 'Liked', unlike: 'Like removed', block: 'Blocked' }[action] || 'Done');
      this.loadState();
    },

    toggleSelect(id) {
      this.selected = this.selected.includes(id) ? this.selected.filter((x) => x !== id) : [...this.selected, id];
    },
    selectAll() { this.selected = this.selected.length === this.rows.length ? [] : this.rows.map((r) => r.id); },

    bulkProgress: null,

    // One request per comment, in order, so each card updates the moment Facebook confirms it.
    // The server still spaces writes by the global throttle; a safety block (kill switch, cap,
    // cooldown) stops the rest.
    async bulk(action) {
      const ids = [...this.selected];
      const n = ids.length;
      if (!n || this.bulkProgress) return;
      if (action === 'delete' && !confirm(`Delete ${n} comment${n === 1 ? '' : 's'} permanently?`)) return;
      const verb = { delete: 'Deleting', hide: 'Hiding', unhide: 'Unhiding' }[action] || 'Working';
      this.bulkProgress = { verb, done: 0, total: n };
      let done = 0;
      const failures = [];
      for (const id of ids) {
        const { ok, status, data } = await this.applyAction(id, action);
        if (ok) done += 1; else failures.push(data.message || `${action} failed`);
        this.bulkProgress = { verb, done: done + failures.length, total: n };
        if (status === 423) break;
      }
      this.bulkProgress = null;
      this.selected = [];
      const stopped = done + failures.length < n;
      this.toast(`${done} of ${n} ${action === 'delete' ? 'deleted' : 'done'}${failures.length ? ` — ${failures.length} failed: ${failures[0]}` : ''}${stopped ? ' (stopped)' : ''}`, failures.length ? 'error' : 'ok');
      this.loadState();
      this.counts = (await this.api(`/api/comments?filter=${this.filter}&limit=1`)).data.counts || this.counts;
    },

    openReply(row) {
      this.replyOpen = this.replyOpen === row.id ? null : row.id;
      this.replyText = '';
    },

    async draftReply(row) {
      this.replyBusy = true;
      const { ok, data } = await this.api(`/api/comments/${encodeURIComponent(row.id)}/suggest-reply`, { method: 'POST' });
      this.replyBusy = false;
      if (!ok) return this.toast(data.message || 'Could not draft a reply.', 'error');
      this.replyText = data.suggestion.reply;
    },

    async sendReply(row) {
      if (!this.replyText.trim()) return;
      this.replyBusy = true;
      const { ok, data } = await this.api(`/api/comments/${encodeURIComponent(row.id)}/reply`, { method: 'POST', body: { message: this.replyText } });
      this.replyBusy = false;
      if (!ok) return this.toast(data.message || 'Reply failed.', 'error');
      this.patchRow(data.comment);
      this.replyOpen = null;
      this.toast('Reply posted');
    },

    cat(c) { return CATEGORIES[c] || { label: c || 'Not reviewed', cls: 'bg-slate-100 text-slate-500' }; },
    autoStatus(s) { return AUTOMOD_STATUS[s] || null; },
    sevClass(s) {
      if (s == null) return 'text-slate-400';
      if (s >= 7) return 'text-red-600';
      if (s >= 4) return 'text-amber-600';
      return 'text-slate-500';
    },
    showTranslation(r) {
      return r.english_translation && r.english_translation.trim().toLowerCase() !== (r.message || '').trim().toLowerCase();
    },

    // ---------- posts ----------

    async loadPosts() {
      const { ok, data } = await this.api('/api/posts');
      if (!ok) return;
      this.posts = data.posts;
      this.trackedDraft = Object.fromEntries(data.posts.map((p) => [p.id, !!p.tracked]));
    },

    get dirtyCount() {
      return this.posts.filter((p) => !!p.tracked !== !!this.trackedDraft[p.id]).length;
    },

    get visiblePosts() {
      const q = this.postQuery.trim().toLowerCase();
      return this.posts.filter((p) => {
        if (this.postView === 'tracked' && !this.trackedDraft[p.id]) return false;
        if (this.postView === 'ad' && p.source !== 'ad') return false;
        if (this.postView === 'page' && p.source === 'ad') return false;
        if (!q) return true;
        return [p.message, p.campaign_names, p.ad_names, p.id].some((v) => (v || '').toLowerCase().includes(q));
      });
    },

    toggleDraft(id) { this.trackedDraft[id] = !this.trackedDraft[id]; },
    discardDraft() { this.trackedDraft = Object.fromEntries(this.posts.map((p) => [p.id, !!p.tracked])); },

    async saveTracked() {
      this.savingTracked = true;
      const ids = Object.entries(this.trackedDraft).filter(([, v]) => v).map(([k]) => k);
      const { ok, data } = await this.api('/api/posts/track', { method: 'POST', body: { ids } });
      this.savingTracked = false;
      if (!ok) return this.toast(data.message || 'Could not save.', 'error');
      this.posts = data.posts;
      this.discardDraft();
      this.toast(`Saved — ${ids.length} post${ids.length === 1 ? '' : 's'} tracked${data.added ? `, ${data.added} added` : ''}${data.removed ? `, ${data.removed} removed` : ''}`);
      this.loadState();
    },

    async discover() {
      this.discovering = true;
      const { ok, data } = await this.api('/api/posts/refresh', { method: 'POST' });
      this.discovering = false;
      if (data.posts) { this.posts = data.posts; this.trackedDraft = { ...Object.fromEntries(data.posts.map((p) => [p.id, !!p.tracked])), ...this.trackedDraft }; }
      if (!ok) return this.toast(data.ads?.message || data.page?.message || data.message || 'Refresh failed.', 'error');
      this.toast(`Found ${data.ads?.count ?? 0} ad posts and ${data.page?.count ?? 0} Page posts`);
    },

    async addPost() {
      if (!this.addInput.trim()) return;
      this.addBusy = true;
      const { ok, data } = await this.api('/api/posts/add', { method: 'POST', body: { input: this.addInput } });
      this.addBusy = false;
      if (!ok) return this.toast(data.message || 'Could not add that post.', 'error');
      this.addInput = '';
      const dirty = { ...this.trackedDraft };
      this.posts = data.posts;
      this.trackedDraft = { ...Object.fromEntries(data.posts.map((p) => [p.id, !!p.tracked])), ...dirty, [data.post.id]: true };
      this.toast('Post added and tracked');
      this.loadState();
    },

    async reviewBacklog(p) {
      if (!confirm('Apply your policy to the comments this post had BEFORE you started tracking it?\n\nWith the current settings, matching comments will be ' + (this.state.settings.dryRun ? 'logged only (dry run).' : 'hidden/deleted for real.'))) return;
      this.toast('Reviewing older comments…');
      const { ok, data } = await this.api(`/api/posts/${encodeURIComponent(p.id)}/review-backlog`, { method: 'POST' });
      if (!ok) return this.toast(data.message || 'Could not run.', 'error');
      this.toast(this.runSummary(data.run), data.run?.status === 'error' ? 'error' : 'ok');
      this.loadPosts();
      this.loadComments();
    },

    viewComments(p) {
      this.postFilter = p.id;
      this.filter = 'all';
      this.go('comments');
    },

    // ---------- activity ----------

    async loadActivity() {
      const [r, a] = await Promise.all([this.api('/api/runs?limit=40'), this.api('/api/actions?limit=60')]);
      if (r.ok) this.runs = r.data.runs;
      if (a.ok) this.recentActions = a.data.actions;
    },

    async toggleRun(run) {
      if (this.openRunId === run.id) { this.openRunId = null; return; }
      this.openRunId = run.id;
      if (!this.runActions[run.id]) {
        const { ok, data } = await this.api(`/api/runs/${run.id}`);
        if (ok) this.runActions[run.id] = data.actions;
      }
    },

    runTone(r) {
      if (r.status === 'error') return 'bg-red-500';
      if (r.status === 'partial') return 'bg-amber-500';
      if (r.status === 'running') return 'bg-blue-500 animate-pulse';
      return 'bg-emerald-500';
    },

    actionLabel(a) {
      if (a.dry_run) return `Would ${a.action}`;
      if (!a.success) return `${a.action[0].toUpperCase()}${a.action.slice(1)} failed`;
      return { delete: 'Deleted', hide: 'Hid', unhide: 'Unhid', reply: 'Replied to', like: 'Liked', unlike: 'Unliked', block: 'Blocked', unblock: 'Unblocked' }[a.action] || a.action;
    },

    // ---------- settings ----------

    get settingsDirty() {
      return this.settingsDraft && JSON.stringify(this.settingsDraft) !== JSON.stringify(this.state?.settings);
    },

    async saveSettings() {
      const d = this.settingsDraft;
      if (d.enabled && !d.dryRun && !this.state.settings.enabled) {
        const deleting = Object.entries(d.policy).filter(([, p]) => p.action === 'delete').length;
        if (deleting && !confirm(`Turn on live automation? Every ${d.intervalMinutes} minutes, new comments matching ${deleting} categor${deleting === 1 ? 'y' : 'ies'} will be deleted permanently.`)) return;
      }
      this.savingSettings = true;
      const { ok, data } = await this.api('/api/settings', { method: 'POST', body: d });
      this.savingSettings = false;
      if (!ok) return this.toast(data.message || 'Could not save settings.', 'error');
      this.state.settings = data.settings;
      this.state.scheduler = data.scheduler;
      this.settingsDraft = JSON.parse(JSON.stringify(data.settings));
      this.toast('Settings saved');
    },

    async setKillSwitch(on) {
      if (on && !confirm('Stop ALL Meta calls (fetching and moderation) until you turn this off?')) return;
      const { ok, data } = await this.api('/api/kill-switch', { method: 'POST', body: { on } });
      if (!ok) return this.toast('Could not change the kill switch.', 'error');
      this.state.safety = data.safety;
      this.toast(on ? 'Kill switch on — nothing will be sent to Meta' : 'Kill switch off');
      this.loadState();
    },

    async loadBlocked() {
      const { ok, data } = await this.api('/api/blocked');
      if (ok) this.blocked = data.blocked;
    },

    async unblock(b) {
      if (!confirm(`Unblock ${b.name || b.psid}?`)) return;
      const { ok, data } = await this.api(`/api/blocked/${encodeURIComponent(b.psid)}/unblock`, { method: 'POST' });
      if (!ok) return this.toast(data.message || 'Unblock failed.', 'error');
      this.blocked = data.blocked;
      this.toast('Unblocked');
    },

    // ---------- formatting ----------

    ago(iso) {
      if (!iso) return '—';
      const s = Math.round((this.now - Date.parse(iso)) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
      return new Date(iso).toLocaleDateString();
    },
    when(iso) { return iso ? new Date(iso).toLocaleString() : '—'; },
    clip(s, n = 140) { s = s || ''; return s.length > n ? `${s.slice(0, n)}…` : s; },
    secs(ms) { return ms == null ? '' : `${(ms / 1000).toFixed(1)}s`; },
  };
}

window.app = app;
