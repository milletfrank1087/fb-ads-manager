function commentsManager() {
  const CAT_LABELS = {
    hate: 'hate', harassment: 'harassment', threat: 'threat',
    scam_accusation: 'scam', ai_accusation: 'AI claim', fake_accusation: 'fake claim',
    spam: 'spam', negative_criticism: 'criticism', safe: 'safe',
  };
  const CAT_CLASSES = {
    hate: 'bg-red-100 text-red-800', harassment: 'bg-red-100 text-red-800', threat: 'bg-red-100 text-red-800',
    scam_accusation: 'bg-orange-100 text-orange-800', ai_accusation: 'bg-amber-100 text-amber-800',
    fake_accusation: 'bg-amber-100 text-amber-800', spam: 'bg-purple-100 text-purple-800',
    negative_criticism: 'bg-yellow-100 text-yellow-800', safe: 'bg-green-100 text-green-700',
  };

  return {
    isOpen: false,
    tab: 'inbox',

    targetPageId: null,
    moderationEnabled: false,
    analyzerEnabled: false,
    killSwitch: false,

    summary: {},
    posts: [],
    selectedPostId: null,
    newCounts: {},

    rows: [],
    total: 0,
    offset: 0,
    limit: 100,
    filter: 'all',
    sort: 'severity_desc',
    minSev: 0,
    q: '',

    selected: [],
    replyFor: null,
    replyText: '',
    suggestMeta: '',

    rules: [],
    ruleForm: { name: '', pattern: '', match_type: 'contains', case_sensitive: false },
    rulePreview: '',
    rulePreviewSample: [],

    audit: [],
    blocked: [],

    busy: { sync: false, syncComments: false, analyze: false, inbox: false, action: false, suggest: false },
    toast: { show: false, type: 'info', title: '', message: '' },
    showNamesNote: true,
    lastSyncedAt: null,
    reviewSince: null,
    newSinceLastSync: 0,
    reviewWindow: 'all',
    reviewFlaggedOnly: true,
    nowTick: 0,

    get blockedActive() {
      return this.blocked.filter((b) => !b.unblocked_at).length;
    },

    init() {
      try { this.showNamesNote = localStorage.getItem('cm_names_note_dismissed') !== '1'; } catch { /* ignore */ }
      setInterval(() => { this.nowTick = Date.now(); }, 30000);
    },

    dismissNamesNote() {
      this.showNamesNote = false;
      try { localStorage.setItem('cm_names_note_dismissed', '1'); } catch { /* ignore */ }
    },

    async openManager(detail) {
      this.isOpen = true;
      document.body.style.overflow = 'hidden';
      await this.loadState();
      await this.loadNewCounts();
      if (detail && detail.postId && this.posts.some((p) => p.id === detail.postId)) {
        this.selectedPostId = detail.postId;
      } else if (detail && detail.adId) {
        const match = this.posts.find((p) => p.ad_id === detail.adId);
        if (match) this.selectedPostId = match.id;
      }
      this.offset = 0;
      await this.reload();
      if (this.selectedPostId) this.recordVisit(this.selectedPostId);
    },

    close() {
      this.isOpen = false;
      document.body.style.overflow = '';
    },

    // ---------- data loaders ----------

    async api(path, opts) {
      const r = await fetch(path, opts);
      let data = {};
      try { data = await r.json(); } catch { /* ignore */ }
      return { status: r.status, ok: r.ok && data.ok !== false, data };
    },

    async loadState() {
      try {
        const { data } = await this.api('/api/cm/state');
        if (!data.ok) return;
        this.targetPageId = data.targetPageId;
        this.moderationEnabled = data.moderationEnabled;
        this.analyzerEnabled = data.analyzerEnabled;
        this.killSwitch = data.killSwitch;
        this.summary = data.summary || {};
        this.posts = data.posts || [];
        this.rules = data.rules || [];
        this.lastSyncedAt = data.lastSyncedAt || null;
        this.reviewSince = data.reviewSince || null;
        this.newSinceLastSync = data.newSinceLastSync || 0;
      } catch (e) {
        this.toastError('State load error', String(e));
      }
    },

    async reload() {
      this.busy.inbox = true;
      try {
        const params = new URLSearchParams({
          filter: this.filter, sort: this.sort,
          min_sev: String(this.minSev), q: this.q,
          limit: String(this.limit), offset: String(this.offset),
        });
        if (this.selectedPostId) params.set('post_id', this.selectedPostId);
        if (this.tab === 'review' && this.reviewWindow && this.reviewWindow !== 'all') params.set('window', this.reviewWindow);
        const { data } = await this.api('/api/cm/inbox?' + params.toString());
        if (data.ok) {
          this.rows = data.rows || [];
          this.total = data.total || 0;
          this.moderationEnabled = data.moderationEnabled;
          if (data.summary) this.summary = data.summary;
        }
      } catch (e) {
        this.toastError('Inbox load error', String(e));
      } finally {
        this.busy.inbox = false;
      }
    },

    async loadNewCounts() {
      try {
        const lastVisits = this.getVisits();
        const { data } = await this.api('/api/cm/new-since', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lastVisits }),
        });
        if (data.ok) this.newCounts = data.counts || {};
      } catch { /* non-critical */ }
    },

    selectPost(id) {
      this.selectedPostId = id;
      this.offset = 0;
      this.clearSelection();
      this.reload();
      if (id) { this.recordVisit(id); this.newCounts[id] = 0; }
    },

    goInbox() {
      this.tab = 'inbox';
      if (this.filter === 'review') this.filter = 'all';
      this.offset = 0;
      this.clearSelection();
      this.reload();
    },

    goReview() {
      this.tab = 'review';
      this.filter = this.reviewFlaggedOnly ? 'review' : 'all';
      this.sort = 'severity_desc';
      this.selectedPostId = null;
      this.minSev = 0;
      this.q = '';
      this.offset = 0;
      this.clearSelection();
      this.loadState();
      this.reload();
    },

    applyReviewControls() {
      this.filter = this.reviewFlaggedOnly ? 'review' : 'all';
      this.offset = 0;
      this.clearSelection();
      this.reload();
    },

    // ---------- sync + analyze ----------

    async sync() {
      if (this.busy.sync || this.killSwitch) return;
      this.busy.sync = true;
      this.toastInfo('Sync started', 'Discovering posts, fetching comments, AI review…');
      try {
        const { data } = await this.api('/api/cm/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ analyze: true, apply_rules: true }),
        });
        if (!data.ok) { this.toastError('Sync failed', data.message || data.error || 'unknown'); return; }
        await this.loadState();
        await this.loadNewCounts();
        await this.reload();
        this.toastInfo('Sync complete',
          `${data.postsSynced} posts · ${data.comments} comments · ${data.analyzed} reviewed · ${data.autoHidden} auto-hidden`);
      } catch (e) {
        this.toastError('Sync error', String(e));
      } finally {
        this.busy.sync = false;
      }
    },

    async syncComments() {
      if (this.busy.syncComments || this.busy.sync || this.killSwitch) return;
      this.busy.syncComments = true;
      this.toastInfo('Syncing comments', 'Re-pulling comments for known posts + AI review…');
      try {
        const { data } = await this.api('/api/cm/sync-comments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ analyze: true, apply_rules: true }),
        });
        if (!data.ok) { this.toastError('Comment sync failed', data.message || data.error || 'unknown'); return; }
        await this.loadState();
        await this.loadNewCounts();
        await this.reload();
        this.toastInfo('Comments synced',
          `${data.postsSynced} posts · ${data.comments} comments · ${data.analyzed} reviewed · ${data.autoHidden} auto-hidden`);
      } catch (e) {
        this.toastError('Comment sync error', String(e));
      } finally {
        this.busy.syncComments = false;
      }
    },

    async analyzeAll() {
      if (this.busy.analyze || !this.analyzerEnabled) return;
      this.busy.analyze = true;
      try {
        const { data } = await this.api('/api/cm/analyze', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: false }),
        });
        if (!data.ok) { this.toastError('AI review failed', data.message || data.error || 'unknown'); return; }
        await this.loadState();
        await this.reload();
        this.toastInfo('AI review complete', `${data.analyzed} analyzed · ${data.failed} failed`);
      } catch (e) {
        this.toastError('AI review error', String(e));
      } finally {
        this.busy.analyze = false;
      }
    },

    // ---------- per-comment actions ----------

    async act(cm, action) {
      if (!this.moderationEnabled || this.busy.action) return;
      this.busy.action = true;
      try {
        const { status, data } = await this.api(`/api/cm/comments/${encodeURIComponent(cm.id)}/${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!data.ok) { this.toastError('Action failed', this.errMsg(status, data)); return; }
        if (data.summary) this.summary = data.summary;
        if (action === 'like' || action === 'unlike') {
          if (data.row) this.patchRow(cm.id, data.row);
        } else {
          await this.reload();
          await this.loadState();
        }
      } catch (e) {
        this.toastError('Action error', String(e));
      } finally {
        this.busy.action = false;
      }
    },

    async del(cm) {
      if (!this.moderationEnabled) return;
      if (!confirm('Permanently delete this comment on Facebook? This cannot be undone.')) return;
      this.busy.action = true;
      try {
        const { status, data } = await this.api(`/api/cm/comments/${encodeURIComponent(cm.id)}`, { method: 'DELETE' });
        if (!data.ok) { this.toastError('Delete failed', this.errMsg(status, data)); return; }
        if (data.summary) this.summary = data.summary;
        this.rows = this.rows.filter((r) => r.id !== cm.id);
        this.total = Math.max(0, this.total - 1);
        await this.loadState();
        this.toastInfo('Comment deleted', '');
      } catch (e) {
        this.toastError('Delete error', String(e));
      } finally {
        this.busy.action = false;
      }
    },

    async delBlock(cm) {
      if (!this.moderationEnabled) return;
      if (!confirm('Delete this comment AND block the author from the Page? This cannot be undone.')) return;
      this.busy.action = true;
      try {
        const { status, data } = await this.api(`/api/cm/comments/${encodeURIComponent(cm.id)}/delete-and-block`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!data.ok) { this.toastError('Delete + block failed', this.errMsg(status, data)); return; }
        if (data.summary) this.summary = data.summary;
        this.rows = this.rows.filter((r) => r.id !== cm.id);
        this.total = Math.max(0, this.total - 1);
        await this.loadState();
        const blockedNote = data.result && data.result.blocked === false ? ' (delete only — no PSID to block)' : '';
        this.toastInfo('Comment deleted', 'Author blocked' + blockedNote);
      } catch (e) {
        this.toastError('Delete + block error', String(e));
      } finally {
        this.busy.action = false;
      }
    },

    async block(cm) {
      if (!this.moderationEnabled) return;
      if (!cm.from_id) { this.toastError('Cannot block', 'No Page-Scoped ID for this commenter (privacy-restricted).'); return; }
      if (!confirm('Block this commenter from the Page? The comment stays, but they can no longer interact with the Page.')) return;
      this.busy.action = true;
      try {
        const { status, data } = await this.api(`/api/cm/comments/${encodeURIComponent(cm.id)}/block`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!data.ok) { this.toastError('Block failed', this.errMsg(status, data)); return; }
        if (data.summary) this.summary = data.summary;
        if (data.blocked && this.tab === 'blocked') this.blocked = data.blocked;
        this.toastInfo('Commenter blocked', cm.from_name || cm.from_id);
      } catch (e) {
        this.toastError('Block error', String(e));
      } finally {
        this.busy.action = false;
      }
    },

    async sendReply(cm) {
      if (!this.moderationEnabled || !this.replyText.trim()) return;
      this.busy.action = true;
      try {
        const { status, data } = await this.api(`/api/cm/comments/${encodeURIComponent(cm.id)}/reply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: this.replyText.trim() }),
        });
        if (!data.ok) { this.toastError('Reply failed', this.errMsg(status, data)); return; }
        if (data.row) this.patchRow(cm.id, data.row);
        if (data.summary) this.summary = data.summary;
        this.replyFor = null;
        this.replyText = '';
        this.suggestMeta = '';
        this.toastInfo('Reply posted', '');
      } catch (e) {
        this.toastError('Reply error', String(e));
      } finally {
        this.busy.action = false;
      }
    },

    async suggest(cm) {
      if (!this.analyzerEnabled || this.busy.suggest) return;
      this.replyFor = cm.id;
      this.busy.suggest = true;
      this.suggestMeta = '';
      try {
        const { data } = await this.api(`/api/cm/comments/${encodeURIComponent(cm.id)}/suggest-reply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!data.ok) { this.toastError('Suggestion failed', data.message || data.error || 'unknown'); return; }
        this.replyText = data.suggestion.reply || '';
        this.suggestMeta = `${data.suggestion.tone || ''} · ${data.suggestion.language || ''}`;
      } catch (e) {
        this.toastError('Suggestion error', String(e));
      } finally {
        this.busy.suggest = false;
      }
    },

    // ---------- bulk ----------

    async bulk(action) {
      if (!this.moderationEnabled || !this.selected.length) return;
      const confirmLabels = { delete: 'Delete', 'delete-and-block': 'Delete + block', block: 'Block the author(s) of' };
      if (confirmLabels[action] && !confirm(`${confirmLabels[action]} ${this.selected.length} comment(s)?`)) return;
      this.busy.action = true;
      try {
        const { data } = await this.api('/api/cm/bulk', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ids: this.selected }),
        });
        if (!data.ok) { this.toastError('Bulk action failed', data.message || data.error || 'unknown'); return; }
        if (data.summary) this.summary = data.summary;
        this.clearSelection();
        await this.reload();
        await this.loadState();
        const blockedNote = data.blocked ? ' — stopped early (safety block)' : '';
        this.toastInfo('Bulk ' + action, `${data.succeeded}/${data.total} succeeded${blockedNote}`);
      } catch (e) {
        this.toastError('Bulk error', String(e));
      } finally {
        this.busy.action = false;
      }
    },

    // ---------- rules ----------

    async loadRules() {
      const { data } = await this.api('/api/cm/rules');
      if (data.ok) this.rules = data.rules || [];
    },
    async addRule() {
      if (this.ruleForm.match_type !== 'has_url' && !this.ruleForm.pattern.trim()) {
        this.toastError('Rule invalid', 'Pattern is required'); return;
      }
      const name = this.ruleForm.name.trim() || this.ruleForm.pattern.trim() || 'Rule';
      const { data } = await this.api('/api/cm/rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...this.ruleForm, name }),
      });
      if (!data.ok) { this.toastError('Add rule failed', data.message || data.error || 'unknown'); return; }
      this.rules = data.rules || [];
      this.ruleForm = { name: '', pattern: '', match_type: 'contains', case_sensitive: false };
      this.toastInfo('Rule added', '');
    },
    async toggleRule(r) {
      const { data } = await this.api(`/api/cm/rules/${r.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: !r.is_enabled }),
      });
      if (data.ok) this.rules = data.rules || [];
    },
    async deleteRule(r) {
      if (!confirm(`Delete rule "${r.name}"?`)) return;
      const { data } = await this.api(`/api/cm/rules/${r.id}`, { method: 'DELETE' });
      if (data.ok) this.rules = data.rules || [];
    },
    async previewRules() {
      this.rulePreview = 'Checking…';
      const { data } = await this.api('/api/cm/rules/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!data.ok) { this.rulePreview = 'Preview failed'; return; }
      this.rulePreview = `${data.matchCount} comment(s) would be hidden`;
      this.rulePreviewSample = data.sample || [];
    },
    async applyRules() {
      if (!this.moderationEnabled) return;
      if (!confirm('Hide all comments matching enabled rules now?')) return;
      const { data } = await this.api('/api/cm/rules/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!data.ok) { this.toastError('Apply failed', data.message || data.error || 'unknown'); return; }
      if (data.summary) this.summary = data.summary;
      this.rulePreview = `Hid ${data.applied} of ${data.matched} matches`;
      this.rulePreviewSample = [];
      await this.loadRules();
      await this.loadState();
    },

    // ---------- audit + blocked ----------

    async loadAudit() {
      const { data } = await this.api('/api/cm/audit?limit=200');
      if (data.ok) this.audit = data.log || [];
    },
    async loadBlocked() {
      const { data } = await this.api('/api/cm/blocked');
      if (data.ok) this.blocked = data.blocked || [];
    },
    async unblock(b) {
      if (!this.moderationEnabled) return;
      if (!confirm(`Unblock ${b.name || b.psid}?`)) return;
      const { status, data } = await this.api(`/api/cm/blocked/${encodeURIComponent(b.psid)}/unblock`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!data.ok) { this.toastError('Unblock failed', this.errMsg(status, data)); return; }
      this.blocked = data.blocked || [];
      this.toastInfo('User unblocked', '');
    },

    // ---------- pagination ----------

    nextPage() { if (this.offset + this.rows.length < this.total) { this.offset += this.limit; this.reload(); } },
    prevPage() { if (this.offset > 0) { this.offset = Math.max(0, this.offset - this.limit); this.reload(); } },

    // ---------- selection ----------

    isSelected(id) { return this.selected.includes(id); },
    toggleSelect(id) {
      const i = this.selected.indexOf(id);
      if (i === -1) this.selected.push(id); else this.selected.splice(i, 1);
    },
    selectAllVisible() {
      const ids = new Set(this.selected);
      for (const r of this.rows) ids.add(r.id);
      this.selected = [...ids];
    },
    clearSelection() { this.selected = []; },

    // ---------- helpers ----------

    patchRow(id, newRow) {
      const i = this.rows.findIndex((r) => r.id === id);
      if (i !== -1) this.rows[i] = { ...this.rows[i], ...newRow };
    },
    errMsg(status, data) {
      if (status === 423) return data.message || 'Blocked by safety (moderation off / kill switch / cap).';
      return data.message || data.error || 'unknown';
    },
    catLabel(c) { return CAT_LABELS[c] || c; },
    catClass(c) { return CAT_CLASSES[c] || 'bg-gray-100 text-meta-gray-600'; },
    sevClass(s) {
      if (s >= 8) return 'bg-red-100 text-red-800';
      if (s >= 5) return 'bg-orange-100 text-orange-800';
      if (s >= 3) return 'bg-yellow-100 text-yellow-800';
      return 'bg-gray-100 text-meta-gray-600';
    },
    actionClass(a) {
      if (a === 'delete') return 'bg-red-100 text-red-800';
      if (a === 'review') return 'bg-yellow-100 text-yellow-800';
      return 'bg-green-100 text-green-700';
    },
    getVisits() {
      try { return JSON.parse(localStorage.getItem('cm_visits') || '{}'); } catch { return {}; }
    },
    recordVisit(postId) {
      const v = this.getVisits();
      v[postId] = new Date().toISOString();
      try { localStorage.setItem('cm_visits', JSON.stringify(v)); } catch { /* ignore */ }
    },
    timeAgo(iso) {
      if (!iso) return '—';
      const t = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
      if (Number.isNaN(t)) return '—';
      const delta = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if (delta < 5) return 'just now';
      if (delta < 60) return delta + 's ago';
      if (delta < 3600) return Math.floor(delta / 60) + 'm ago';
      if (delta < 86400) return Math.floor(delta / 3600) + 'h ago';
      return Math.floor(delta / 86400) + 'd ago';
    },
    toastError(title, message) { this.toast = { show: true, type: 'error', title, message }; setTimeout(() => (this.toast.show = false), 7000); },
    toastInfo(title, message) { this.toast = { show: true, type: 'info', title, message }; setTimeout(() => (this.toast.show = false), 4000); },
  };
}
