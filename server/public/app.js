
function dashboard() {
  return {
    loading: false,
    loadingScope: null,
    autoRefreshOn: true,
    _autoRefreshTimer: null,
    meta: { version: 'v25.0', primaryAccountId: '', timezone: '' },
    safety: { dailyCallsUsed: 0, dailyCallCap: 500, readonly: true, killSwitch: false, cooldowns: [], proxy: '' },
    account: null,

    level: 'campaign',
    parentCampaignId: null,
    parentAdsetId: null,
    breadcrumb: null,
    rows: [],
    lastRun: null,
    lastInsightsFetchedAt: null,
    oldestInsightsFetchedAt: null,
    rowsWithoutInsights: 0,
    nowTick: Date.now(),
    totals: {},
    usageSamples: [],
    rateLimitDetails: null,
    datePreset: 'today',
    sortField: 'spend',
    sortDir: 'desc',

    filterMode: 'active',

    columnsOpen: false,
    presetsOpen: false,
    rateLimitOpen: false,
    visibleColumns: {},
    columnGroups: COLUMN_GROUPS,

    builtInPresets: BUILT_IN_PRESETS,
    customPresets: [],
    activePresetId: 'default',

    toast: { show: false, type: 'info', title: '', message: '' },

    actionPending: {},
    budgetEdit: { id: null, level: null, kind: 'daily', dollars: '' },
    nameEdit: { id: null, value: '' },

    tools: {
      open: false,
      row: null,
      level: null,
      tab: 'breakdowns',
      breakdown: 'age_gender',
      datePreset: 'last_7d',
      breakdowns: { loading: false, rows: [], dims: [], error: '' },
      activities: { loading: false, rows: [], error: '' },
      preview: { loading: false, iframe: '', format: 'DESKTOP_FEED_STANDARD', error: '' },
    },
    breakdownOptions: [
      { id: 'age_gender', label: 'Age & gender', tip: 'Performance split by age bracket and gender — find your best-converting demographics.' },
      { id: 'country', label: 'Country', tip: 'Performance split by country.' },
      { id: 'region', label: 'Region', tip: 'Performance split by region/state within countries.' },
      { id: 'platform', label: 'Platform', tip: 'Facebook vs Instagram vs Audience Network vs Messenger.' },
      { id: 'placement', label: 'Placement', tip: 'Platform + position (Feed, Stories, Reels, Marketplace, etc.).' },
      { id: 'device', label: 'Device', tip: 'Impression device (mobile, desktop, tablet).' },
      { id: 'hourly', label: 'Hour of day', tip: 'Performance by hour of day (advertiser time zone) — find peak hours.' },
    ],
    previewFormats: [
      { id: 'DESKTOP_FEED_STANDARD', label: 'Desktop Feed' },
      { id: 'MOBILE_FEED_STANDARD', label: 'Mobile Feed' },
      { id: 'INSTAGRAM_STANDARD', label: 'Instagram Feed' },
      { id: 'INSTAGRAM_STORY', label: 'Instagram Story' },
      { id: 'FACEBOOK_STORY_MOBILE', label: 'Facebook Story' },
      { id: 'INSTAGRAM_REELS', label: 'Instagram Reels' },
      { id: 'RIGHT_COLUMN_STANDARD', label: 'Right Column' },
    ],

    strategy: {
      open: false,
      tab: 'briefing',
      loading: false,
      aiLoading: false,
      briefingLoading: false,
      window: 'last_30d',
      data: null,
      narrative: null,
      briefing: null,
      copied: false,
      error: '',
      chat: { messages: [], input: '', loading: false, error: '', sessionId: '' },
      briefOpen: false,
      briefSaving: false,
      briefSaved: false,
      profile: { riskTolerance: 'balanced', brandVoice: '', notes: '', campaigns: [] },
      armed: false,
      envForced: false,
      armBusy: false,
    },
    strategyWindows: [
      { id: 'last_7d', label: 'Last 7 days' },
      { id: 'last_14d', label: 'Last 14 days' },
      { id: 'last_28d', label: 'Last 28 days' },
      { id: 'last_30d', label: 'Last 30 days' },
      { id: 'last_90d', label: 'Last 90 days' },
    ],
    advisorSuggestions: [
      'How did yesterday compare to our usual day?',
      'Which campaign is safe to scale right now, and by how much?',
      'What are people saying in the comments — any objections or spam?',
      'Find my worst ad set and propose what to do about it',
    ],

    get canManage() {
      return !!this.safety.allowAdManagement && !this.safety.killSwitch;
    },
    get manageHint() {
      if (this.safety.killSwitch) return 'Kill switch is engaged — all Meta writes are halted.';
      if (!this.safety.allowAdManagement) return 'Ad management is read-only. Set FB_ALLOW_AD_MANAGEMENT=1 and restart to enable pause/resume and budget edits.';
      return 'Ad management is enabled. Changes are sent to Meta and take effect immediately.';
    },

    get dailyPct() {
      const cap = this.safety.dailyCallCap || 1;
      return Math.round((this.safety.dailyCallsUsed / cap) * 100);
    },
    get activeCount() {
      return this.rows.filter((c) => (c.effective_status || c.status) === 'ACTIVE').length;
    },
    get visibleColumnCount() {
      return ORDERED_COLUMNS.filter((c) => this.visibleColumns[c.id] !== false).length;
    },
    get visibleOrderedColumns() {
      return ORDERED_COLUMNS.filter((c) => this.visibleColumns[c.id] !== false);
    },
    get levelNoun() {
      return this.level === 'campaign' ? 'Campaign' : this.level === 'adset' ? 'Ad Set' : 'Ad';
    },
    get levelNounPlural() {
      return this.level === 'campaign' ? 'campaigns' : this.level === 'adset' ? 'ad sets' : 'ads';
    },
    get levelTitle() {
      if (this.level === 'campaign') return 'Campaigns';
      if (this.level === 'adset') return this.parentCampaignId ? `Ad Sets · ${this.breadcrumb?.campaignName || ''}` : 'All Ad Sets';
      return this.parentAdsetId
        ? `Ads · ${this.breadcrumb?.adsetName || ''}`
        : this.parentCampaignId
          ? `Ads · ${this.breadcrumb?.campaignName || ''}`
          : 'All Ads';
    },
    get canDrillDown() {
      return this.level === 'campaign' || this.level === 'adset';
    },
    get insightsAgeSec() {
      if (!this.lastInsightsFetchedAt) return null;
      const t = new Date(this.lastInsightsFetchedAt).getTime();
      if (Number.isNaN(t)) return null;
      return Math.max(0, Math.floor((this.nowTick - t) / 1000));
    },
    get stalenessLevel() {
      const a = this.insightsAgeSec;
      if (a == null) return this.rowsWithoutInsights > 0 ? 'none' : 'fresh';
      if (a >= STALE_OLD_SEC) return 'old';
      if (a >= STALE_WARN_SEC) return 'stale';
      return 'fresh';
    },
    get stalenessClass() {
      const s = this.stalenessLevel;
      if (s === 'old') return 'text-red-700 font-medium';
      if (s === 'stale') return 'text-yellow-700 font-medium';
      return 'text-meta-gray-600';
    },
    rowStaleness(c) {
      const ts = c.insights_fetched_at;
      if (!ts) return 'missing';
      const t = new Date(ts).getTime();
      if (Number.isNaN(t)) return 'missing';
      const age = Math.floor((this.nowTick - t) / 1000);
      if (age >= STALE_OLD_SEC) return 'old';
      if (age >= STALE_WARN_SEC) return 'stale';
      return 'fresh';
    },
    get maxUsagePct() {
      const a = this.safety || {};
      return Math.max(a.appMaxPct || 0, a.bucMaxPct || 0, a.insightsAppPct || 0, a.insightsAccPct || 0);
    },
    get autoRefreshBlocked() {
      if (!this.autoRefreshOn) return true;
      if (this.safety.killSwitch) return true;
      if (this.maxUsagePct >= SAFETY_USAGE_PCT_BLOCK) return true;
      if (typeof document !== 'undefined' && document.hidden) return true;
      const cap = this.safety.dailyCallCap || 1;
      if ((this.safety.dailyCallsUsed || 0) / cap >= 0.8) return true;
      return false;
    },
    get activePresetLabel() {
      const all = [...BUILT_IN_PRESETS, ...this.customPresets];
      const p = all.find((x) => x.id === this.activePresetId);
      return p ? p.name : 'Custom';
    },
    get displayedRows() {
      let arr = [...this.rows];
      if (this.filterMode === 'active') {
        arr = arr.filter((c) => (c.effective_status || c.status) === 'ACTIVE');
      } else if (this.filterMode === 'delivered') {
        arr = arr.filter((c) => (c.impressions || 0) > 0);
      }
      const f = this.sortField;
      const dir = this.sortDir === 'desc' ? -1 : 1;
      arr.sort((a, b) => {
        let av = a[f];
        let bv = b[f];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'string') return av.localeCompare(bv) * dir;
        return (av - bv) * dir;
      });
      return arr;
    },

    async init() {
      this.loadFilterMode();
      this.loadCustomPresets();
      this.loadActivePreset();
      this.loadColumnPrefs();
      const builtIn = BUILT_IN_PRESETS.find((p) => p.id === this.activePresetId);
      if (builtIn) this.applyPreset(builtIn.id);
      this.loadAutoRefresh();
      await this.refreshDashboardData();
      await this.refreshUsage();
      await this.refreshRateLimitDetails();
      setInterval(() => { this.refreshUsage(); }, 8000);
      setInterval(() => { this.nowTick = Date.now(); }, 5000);
      this.startAutoRefresh();
    },

    loadAutoRefresh() {
      try {
        const v = localStorage.getItem(LS_AUTO_REFRESH);
        if (v === 'on' || v === 'off') this.autoRefreshOn = v === 'on';
      } catch {}
    },
    saveAutoRefresh() {
      try { localStorage.setItem(LS_AUTO_REFRESH, this.autoRefreshOn ? 'on' : 'off'); } catch {}
      if (this.autoRefreshOn) this.startAutoRefresh(); else this.stopAutoRefresh();
    },
    startAutoRefresh() {
      this.stopAutoRefresh();
      this._autoRefreshTimer = setInterval(() => {
        if (this.autoRefreshBlocked) return;
        if (this.loading) return;
        const age = this.insightsAgeSec;
        if (age == null || age >= STALE_WARN_SEC) {
          this.refreshLevelNow({ silent: true });
        }
      }, AUTO_REFRESH_INTERVAL_MS);
    },
    stopAutoRefresh() {
      if (this._autoRefreshTimer) { clearInterval(this._autoRefreshTimer); this._autoRefreshTimer = null; }
    },

    loadFilterMode() {
      try {
        const v = localStorage.getItem(LS_FILTER_MODE);
        if (v === 'all' || v === 'active' || v === 'delivered') this.filterMode = v;
      } catch {}
    },
    setFilterMode(mode) {
      this.filterMode = mode;
      try { localStorage.setItem(LS_FILTER_MODE, mode); } catch {}
    },

    loadCustomPresets() {
      try {
        const raw = localStorage.getItem(LS_PRESETS);
        if (raw) this.customPresets = JSON.parse(raw) || [];
      } catch {}
    },
    saveCustomPresets() {
      try { localStorage.setItem(LS_PRESETS, JSON.stringify(this.customPresets)); } catch {}
    },
    loadActivePreset() {
      try {
        const v = localStorage.getItem(LS_ACTIVE_PRESET);
        if (v) this.activePresetId = v;
      } catch {}
    },
    saveActivePreset() {
      try { localStorage.setItem(LS_ACTIVE_PRESET, this.activePresetId); } catch {}
    },
    applyPreset(id) {
      const all = [...BUILT_IN_PRESETS, ...this.customPresets];
      const p = all.find((x) => x.id === id);
      if (!p) return;
      const set = new Set(p.columns);
      const next = {};
      for (const col of ORDERED_COLUMNS) next[col.id] = set.has(col.id);
      this.visibleColumns = next;
      this.activePresetId = id;
      this.saveColumnPrefs();
      this.saveActivePreset();
    },
    saveCurrentAsPreset() {
      const name = window.prompt('Save current visible columns as preset. Name:');
      if (!name) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      const id = 'user_' + Date.now().toString(36);
      const visible = ORDERED_COLUMNS.filter((c) => this.visibleColumns[c.id] !== false).map((c) => c.id);
      this.customPresets = [...this.customPresets, { id, name: trimmed, columns: visible }];
      this.saveCustomPresets();
      this.activePresetId = id;
      this.saveActivePreset();
      this.toastInfo('Preset saved', `"${trimmed}" with ${visible.length} columns`);
    },
    deletePreset(id) {
      if (!confirm('Delete this preset?')) return;
      this.customPresets = this.customPresets.filter((p) => p.id !== id);
      this.saveCustomPresets();
      if (this.activePresetId === id) {
        this.activePresetId = 'default';
        this.saveActivePreset();
      }
    },

    loadColumnPrefs() {
      let stored = null;
      try {
        const raw = localStorage.getItem(LS_COLS);
        if (raw) stored = JSON.parse(raw);
      } catch {}
      const next = {};
      for (const col of ORDERED_COLUMNS) {
        if (stored && typeof stored[col.id] === 'boolean') {
          next[col.id] = stored[col.id];
        } else {
          next[col.id] = DEFAULT_VISIBLE_COLUMN_IDS.has(col.id);
        }
      }
      this.visibleColumns = next;
      this.saveColumnPrefs();
    },
    saveColumnPrefs() {
      try { localStorage.setItem(LS_COLS, JSON.stringify(this.visibleColumns)); } catch {}
    },
    resetColumnsToDefault() {
      this.applyPreset('default');
    },
    toggleColumn(id) {
      this.visibleColumns[id] = this.visibleColumns[id] === false ? true : !this.visibleColumns[id];
      if (this.visibleColumns[id] === undefined) this.visibleColumns[id] = false;
      this.markPresetCustom();
      this.saveColumnPrefs();
    },
    toggleAllColumns(on) {
      const next = {};
      for (const col of ORDERED_COLUMNS) next[col.id] = on;
      this.visibleColumns = next;
      this.markPresetCustom();
      this.saveColumnPrefs();
    },
    toggleGroup(groupId) {
      const group = COLUMN_GROUPS.find((g) => g.id === groupId);
      if (!group) return;
      const allOn = this.isGroupAllOn(groupId);
      const next = { ...this.visibleColumns };
      for (const col of group.columns) next[col.id] = !allOn;
      this.visibleColumns = next;
      this.markPresetCustom();
      this.saveColumnPrefs();
    },
    isGroupAllOn(groupId) {
      const group = COLUMN_GROUPS.find((g) => g.id === groupId);
      if (!group) return false;
      return group.columns.every((c) => this.visibleColumns[c.id] !== false);
    },
    markPresetCustom() {
      this.activePresetId = '__custom__';
      this.saveActivePreset();
    },

    qs() {
      const p = new URLSearchParams();
      p.set('date_preset', this.datePreset);
      p.set('level', this.level);
      if (this.parentCampaignId) p.set('campaign_id', this.parentCampaignId);
      if (this.parentAdsetId) p.set('adset_id', this.parentAdsetId);
      return p.toString();
    },

    async refreshDashboardData() {
      try {
        const r = await fetch(`/api/dashboard?${this.qs()}`);
        const data = await r.json();
        if (!data.ok) {
          this.toastError('Dashboard load failed', data.error || 'unknown');
          return;
        }
        this.account = data.account;
        this.rows = data.rows || data.campaigns || [];
        this.lastRun = data.lastRun;
        this.lastInsightsFetchedAt = data.lastInsightsFetchedAt || null;
        this.oldestInsightsFetchedAt = data.oldestInsightsFetchedAt || null;
        this.rowsWithoutInsights = data.rowsWithoutInsights || 0;
        this.totals = data.totals || {};
        this.breadcrumb = data.breadcrumb || null;
        this.meta = { ...this.meta, ...data.meta };
        this.safety = { ...this.safety, ...data.safety };
      } catch (e) {
        this.toastError('Dashboard load error', String(e));
      }
    },
    async refreshUsage() {
      try {
        const r = await fetch('/api/usage?limit=100');
        const data = await r.json();
        if (data.ok) {
          this.usageSamples = data.samples || [];
          this.safety = { ...this.safety, ...data.safety };
        }
      } catch {}
    },
    async refreshRateLimitDetails() {
      try {
        const r = await fetch('/api/rate-limit-details');
        const data = await r.json();
        if (data.ok) {
          this.rateLimitDetails = data;
          this.safety = { ...this.safety, ...data.safety };
        }
      } catch {}
    },
    async refreshLevelNow({ silent = false } = {}) {
      if (this.loading || this.safety.killSwitch) return;
      this.loading = true;
      this.loadingScope = 'level';
      try {
        const body = {
          date_preset: this.datePreset,
          level: this.level,
          campaign_id: this.parentCampaignId,
          adset_id: this.parentAdsetId,
          only_had_delivery: this.filterMode === 'delivered',
        };
        const r = await fetch('/api/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!data.ok) {
          this.toastError('Refresh failed', data.error || data.reason || 'unknown');
        } else if (!silent) {
          const n = data.refresh?.entitiesCount ?? data.refresh?.campaignsCount ?? (data.rows?.length || 0);
          this.toastInfo(`Refreshed ${this.levelNounPlural}`, `${n} rows · ${data.refresh?.elapsedMs || 0}ms`);
        }
      } catch (e) {
        if (!silent) this.toastError('Refresh error', String(e));
      } finally {
        this.loading = false;
        this.loadingScope = null;
        await this.refreshDashboardData();
        await this.refreshUsage();
        await this.refreshRateLimitDetails();
      }
    },
    async refreshAllNow() {
      if (this.loading || this.safety.killSwitch) return;
      this.loading = true;
      this.loadingScope = 'all';
      try {
        const r = await fetch('/api/refresh-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date_preset: this.datePreset, only_had_delivery: this.filterMode === 'delivered' }),
        });
        const data = await r.json();
        if (!data.ok) {
          this.toastError('Refresh all failed', data.error || 'unknown');
        } else {
          const ra = data.refreshAll || {};
          const c = ra.results?.campaign?.campaignsCount || 0;
          const a = ra.results?.adset?.entitiesCount || 0;
          const d = ra.results?.ad?.entitiesCount || 0;
          this.toastInfo('Refreshed all 3 levels', `${c} campaigns · ${a} ad sets · ${d} ads · ${ra.elapsedMs}ms · ${ra.httpCalls} HTTP`);
        }
      } catch (e) {
        this.toastError('Refresh all error', String(e));
      } finally {
        this.loading = false;
        this.loadingScope = null;
        await this.refreshDashboardData();
        await this.refreshUsage();
        await this.refreshRateLimitDetails();
      }
    },
    async onDatePresetChange() {
      await this.refreshDashboardData();
    },

    setLevel(level, campaignId, adsetId) {
      if (level === 'campaign') { campaignId = null; adsetId = null; }
      if (level === 'adset') { adsetId = null; }
      this.level = level;
      this.parentCampaignId = campaignId || null;
      this.parentAdsetId = adsetId || null;
      this.refreshDashboardData();
    },
    drillInto(row) {
      if (this.level === 'campaign') {
        this.setLevel('adset', row.id, null);
      } else if (this.level === 'adset') {
        this.setLevel('ad', row.campaign_id || this.parentCampaignId, row.id);
      }
    },

    sortBy(field) {
      if (this.sortField === field) {
        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        this.sortField = field;
        this.sortDir = 'desc';
      }
    },
    sortIcon(field) {
      if (this.sortField !== field) return '';
      return this.sortDir === 'desc' ? '↓' : '↑';
    },

    formatMoney(v) {
      if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
      const n = Number(v);
      const cur = this.account?.currency || 'USD';
      const sym = cur === 'EUR' ? '€' : cur === 'USD' ? '$' : cur === 'GBP' ? '£' : cur + ' ';
      const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return `${sym}${fmt.format(n)}`;
    },
    formatInt(v) {
      if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
      return new Intl.NumberFormat('en-US').format(Math.round(Number(v)));
    },
    formatPct(v) {
      if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
      const n = Number(v);
      return n.toFixed(2) + '%';
    },
    formatFloat2(v) {
      if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
      return Number(v).toFixed(2);
    },
    formatRoas(v) {
      if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
      return Number(v).toFixed(2) + 'x';
    },
    _hasValue(v) {
      return v != null && v !== '' && !Number.isNaN(Number(v));
    },
    _renderValue(v, kind) {
      if (!this._hasValue(v) && kind !== 'badge') return '<span class="text-meta-gray-600">—</span>';
      switch (kind) {
        case 'money': return this.formatMoney(v);
        case 'int': return this.formatInt(v);
        case 'pct': return this.formatPct(v);
        case 'float2': return this.formatFloat2(v);
        case 'roas': return this.formatRoas(v);
        default: return v == null ? '<span class="text-meta-gray-600">—</span>' : String(v);
      }
    },
    renderCell(c, col) {
      if (col.kind === 'badge') return this.deliveryBadge(c);
      const v = c[col.field];
      return this._renderValue(v, col.kind);
    },
    renderTotalCell(col) {
      if (col.kind === 'badge') return '';
      const map = {
        spend: 'spend', reach: 'reach', impressions: 'impressions', cpm: 'cpm',
        frequency: 'frequency',
        unique_inline_link_click_ctr: 'uniqueLinkClickCtr',
        unique_inline_link_clicks: 'uniqueInlineLinkClicks',
        cost_per_inline_link_click: 'costPerInlineLinkClick',
        post_comments: 'postComments',
        post_engagements: 'postEngagements',
        link_clicks: 'linkClicks',
        landing_page_views_total: 'landingPageViewsTotal',
        landing_page_views_app: 'landingPageViewsApp',
        landing_page_views_website: 'landingPageViewsWebsite',
        cost_per_landing_page_view: 'costPerLandingPageView',
        atc_total: 'atcTotal', atc_app: 'atcApp', atc_website: 'atcWebsite',
        atc_offline: 'atcOffline', atc_meta: 'atcMeta',
        cost_per_add_to_cart: 'costPerAddToCart',
        ic_total: 'icTotal', ic_app: 'icApp', ic_website: 'icWebsite',
        ic_offline: 'icOffline', ic_meta: 'icMeta',
        cost_per_initiate_checkout: 'costPerInitiateCheckout',
        purchases_total: 'purchasesTotal', purchases_app: 'purchasesApp',
        purchases_website: 'purchasesWebsite', purchases_offline: 'purchasesOffline',
        purchases_meta: 'purchasesMeta',
        cost_per_purchase: 'costPerPurchase',
        purchase_value_total: 'purchaseValueTotal', purchase_value_app: 'purchaseValueApp',
        purchase_value_website: 'purchaseValueWebsite', purchase_value_offline: 'purchaseValueOffline',
        purchase_value_meta: 'purchaseValueMeta',
        purchase_roas_total: 'purchaseRoasTotal',
        purchase_roas_website: 'purchaseRoasWebsite',
        purchase_roas_app: 'purchaseRoasApp',
      };
      const key = map[col.field];
      const v = key ? this.totals[key] : null;
      return this._renderValue(v, col.kind);
    },
    deliveryBadge(c) {
      const s = c.effective_status || c.status;
      const isLive = s === 'ACTIVE';
      const isPaused = s === 'PAUSED' || s === 'CAMPAIGN_PAUSED' || s === 'ADSET_PAUSED';
      const color = isLive
        ? 'bg-green-50 text-green-700 border-green-200'
        : isPaused
        ? 'bg-gray-50 text-meta-gray-600 border-gray-200'
        : 'bg-yellow-50 text-yellow-700 border-yellow-200';
      const label = isLive ? 'Active' : isPaused ? 'Off' : (s || '').replace(/_/g, ' ').toLowerCase();
      const dot = isLive ? 'bg-green-500' : isPaused ? 'bg-gray-400' : 'bg-yellow-500';
      return `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-xs font-medium ${color}"><span class="w-1.5 h-1.5 rounded-full ${dot}"></span>${label}</span>`;
    },
    timeAgo(iso) {
      if (!iso) return '—';
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return '—';
      const delta = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if (delta < 5) return 'just now';
      if (delta < 60) return delta + 's ago';
      if (delta < 3600) return Math.floor(delta / 60) + 'm ago';
      if (delta < 86400) return Math.floor(delta / 3600) + 'h ago';
      return Math.floor(delta / 86400) + 'd ago';
    },
    timeShort(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    },

    // ---------- Ad management (status / budget) ----------
    isPending(id, action) {
      return !!this.actionPending[`${id}:${action}`];
    },
    _setPending(id, action, on) {
      const key = `${id}:${action}`;
      if (on) this.actionPending = { ...this.actionPending, [key]: true };
      else { const next = { ...this.actionPending }; delete next[key]; this.actionPending = next; }
    },
    rowBudgetKind(row) {
      if (row.daily_budget != null && Number(row.daily_budget) > 0) return 'daily';
      if (row.lifetime_budget != null && Number(row.lifetime_budget) > 0) return 'lifetime';
      return null;
    },
    rowBudgetCents(row) {
      const kind = this.rowBudgetKind(row);
      if (kind === 'daily') return Number(row.daily_budget);
      if (kind === 'lifetime') return Number(row.lifetime_budget);
      return null;
    },
    formatBudget(row) {
      const cents = this.rowBudgetCents(row);
      if (cents == null) return null;
      const kind = this.rowBudgetKind(row);
      return `${this.formatMoney(cents / 100)}${kind === 'daily' ? '/day' : ' total'}`;
    },
    async toggleStatus(row) {
      if (!this.canManage) { this.toastError('Ad management is off', this.manageHint); return; }
      const current = row.status || row.effective_status;
      const next = current === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
      const verb = next === 'ACTIVE' ? 'resume (turn ON)' : 'pause (turn OFF)';
      if (!confirm(`${next === 'ACTIVE' ? 'Resume' : 'Pause'} this ${this.levelNoun.toLowerCase()}?\n\n"${row.name}"\n\nThis will ${verb} delivery on Meta immediately.`)) return;
      this._setPending(row.id, 'status', true);
      try {
        const r = await fetch(`/api/ads/${this.level}/${row.id}/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        const data = await r.json();
        if (!data.ok) { this.toastError('Status change failed', data.message || data.error || 'unknown'); return; }
        row.status = next;
        row.effective_status = next;
        this.toastInfo(`${next === 'ACTIVE' ? 'Resumed' : 'Paused'} ${this.levelNoun.toLowerCase()}`, row.name);
        this.refreshUsage();
      } catch (e) {
        this.toastError('Status change error', String(e));
      } finally {
        this._setPending(row.id, 'status', false);
      }
    },
    openBudgetEdit(row) {
      if (!this.canManage) { this.toastError('Ad management is off', this.manageHint); return; }
      const kind = this.rowBudgetKind(row) || 'daily';
      const cents = this.rowBudgetCents(row);
      this.budgetEdit = { id: row.id, level: this.level, kind, dollars: cents != null ? (cents / 100).toFixed(2) : '' };
    },
    cancelBudgetEdit() {
      this.budgetEdit = { id: null, level: null, kind: 'daily', dollars: '' };
    },
    async saveBudget(row) {
      const dollars = parseFloat(this.budgetEdit.dollars);
      if (!Number.isFinite(dollars) || dollars <= 0) { this.toastError('Invalid budget', 'Enter a positive amount.'); return; }
      const cents = Math.round(dollars * 100);
      const kind = this.budgetEdit.kind;
      const body = kind === 'daily' ? { daily_budget: cents } : { lifetime_budget: cents };
      if (!confirm(`Set ${kind === 'daily' ? 'daily' : 'lifetime'} budget for "${row.name}" to ${this.formatMoney(dollars)}?\n\nThis changes spend on Meta immediately.`)) return;
      this._setPending(row.id, 'budget', true);
      try {
        const r = await fetch(`/api/ads/${this.level}/${row.id}/budget`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!data.ok) { this.toastError('Budget change failed', data.message || data.error || 'unknown'); return; }
        if (kind === 'daily') row.daily_budget = cents; else row.lifetime_budget = cents;
        this.toastInfo('Budget updated', `${row.name} → ${this.formatMoney(dollars)}${kind === 'daily' ? '/day' : ' total'}`);
        this.cancelBudgetEdit();
        this.refreshUsage();
      } catch (e) {
        this.toastError('Budget change error', String(e));
      } finally {
        this._setPending(row.id, 'budget', false);
      }
    },
    openRename(row) {
      if (!this.canManage) { this.toastError('Ad management is off', this.manageHint); return; }
      this.nameEdit = { id: row.id, value: row.name || '' };
    },
    cancelRename() {
      this.nameEdit = { id: null, value: '' };
    },
    async saveRename(row) {
      const name = (this.nameEdit.value || '').trim();
      if (!name) { this.toastError('Invalid name', 'Name cannot be empty.'); return; }
      if (name === row.name) { this.cancelRename(); return; }
      this._setPending(row.id, 'rename', true);
      try {
        const r = await fetch(`/api/ads/${this.level}/${row.id}/rename`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const data = await r.json();
        if (!data.ok) { this.toastError('Rename failed', data.message || data.error || 'unknown'); return; }
        row.name = name;
        this.toastInfo('Renamed', `→ ${name}`);
        this.cancelRename();
        this.refreshUsage();
      } catch (e) {
        this.toastError('Rename error', String(e));
      } finally {
        this._setPending(row.id, 'rename', false);
      }
    },
    openComments(row) {
      const detail = this.level === 'ad'
        ? { adId: row.id, postId: row.creative_object_story_id || row.post_id || null }
        : { campaignId: this.level === 'campaign' ? row.id : (row.campaign_id || this.parentCampaignId), name: row.name };
      window.dispatchEvent(new CustomEvent('open-comments-manager', { detail }));
    },

    openTools(row) {
      this.tools.open = true;
      this.tools.row = row;
      this.tools.level = this.level;
      this.tools.tab = 'breakdowns';
      this.tools.datePreset = this.datePreset && this.datePreset !== 'today' ? this.datePreset : 'last_7d';
      this.tools.breakdowns = { loading: false, rows: [], dims: [], error: '' };
      this.tools.activities = { loading: false, rows: [], error: '' };
      this.tools.preview = { loading: false, iframe: '', format: 'DESKTOP_FEED_STANDARD', error: '' };
      this.loadBreakdowns();
    },
    closeTools() {
      this.tools.open = false;
      this.tools.row = null;
    },
    setToolsTab(tab) {
      this.tools.tab = tab;
      if (tab === 'breakdowns' && !this.tools.breakdowns.rows.length) this.loadBreakdowns();
      if (tab === 'history' && !this.tools.activities.rows.length) this.loadActivities();
      if (tab === 'preview' && !this.tools.preview.iframe) this.loadPreview();
    },
    breakdownTotals() {
      const t = { spend: 0, impressions: 0, reach: 0, clicks: 0, purchases: 0, purchase_value: 0 };
      for (const r of this.tools.breakdowns.rows) {
        t.spend += r.spend; t.impressions += r.impressions; t.reach += r.reach;
        t.clicks += r.clicks; t.purchases += r.purchases; t.purchase_value += r.purchase_value;
      }
      t.roas = t.spend ? t.purchase_value / t.spend : null;
      return t;
    },
    async loadBreakdowns() {
      const { row, level } = this.tools;
      if (!row) return;
      this.tools.breakdowns.loading = true;
      this.tools.breakdowns.error = '';
      try {
        const url = `/api/ads/${level}/${row.id}/breakdowns?breakdown=${encodeURIComponent(this.tools.breakdown)}&date_preset=${encodeURIComponent(this.tools.datePreset)}`;
        const r = await fetch(url);
        const data = await r.json();
        if (!data.ok) { this.tools.breakdowns.error = data.message || data.error || 'Failed to load'; this.tools.breakdowns.rows = []; return; }
        this.tools.breakdowns.rows = data.rows || [];
        this.tools.breakdowns.dims = data.dims || [];
      } catch (e) {
        this.tools.breakdowns.error = String(e);
      } finally {
        this.tools.breakdowns.loading = false;
        this.refreshUsage();
      }
    },
    async loadActivities() {
      const { row } = this.tools;
      if (!row) return;
      this.tools.activities.loading = true;
      this.tools.activities.error = '';
      try {
        const r = await fetch(`/api/ads/activities?entity_id=${encodeURIComponent(row.id)}&limit=200`);
        const data = await r.json();
        if (!data.ok) { this.tools.activities.error = data.message || data.error || 'Failed to load'; this.tools.activities.rows = []; return; }
        this.tools.activities.rows = data.rows || [];
      } catch (e) {
        this.tools.activities.error = String(e);
      } finally {
        this.tools.activities.loading = false;
        this.refreshUsage();
      }
    },
    async loadPreview() {
      const { row, level } = this.tools;
      if (!row || level !== 'ad') return;
      this.tools.preview.loading = true;
      this.tools.preview.error = '';
      try {
        const r = await fetch(`/api/ads/ad/${row.id}/preview?ad_format=${encodeURIComponent(this.tools.preview.format)}`);
        const data = await r.json();
        if (!data.ok) { this.tools.preview.error = data.message || data.error || 'No preview'; this.tools.preview.iframe = ''; return; }
        this.tools.preview.iframe = data.iframe || '';
        this.$nextTick(() => {
          const host = document.getElementById('tools-preview-host');
          if (host) host.innerHTML = data.iframe || '';
        });
      } catch (e) {
        this.tools.preview.error = String(e);
      } finally {
        this.tools.preview.loading = false;
        this.refreshUsage();
      }
    },
    activityValue(extra) {
      if (!extra || typeof extra !== 'object') return '';
      const parts = [];
      if (extra.old_value != null || extra.new_value != null) {
        parts.push(`${extra.old_value ?? '—'} → ${extra.new_value ?? '—'}`);
      }
      return parts.join(' ');
    },
    async duplicateRow(row) {
      if (!this.canManage) { this.toastError('Ad management is off', this.manageHint); return; }
      if (this.level !== 'campaign' && this.level !== 'adset') { this.toastError('Cannot duplicate', 'Only campaigns and ad sets can be duplicated.'); return; }
      const noun = this.levelNoun.toLowerCase();
      if (!confirm(`Duplicate this ${noun}?\n\n"${row.name}"\n\nA full PAUSED copy (including its ${this.level === 'campaign' ? 'ad sets & ads' : 'ads'}) will be created. The original is NOT touched and the copy stays OFF until you turn it on.`)) return;
      this._setPending(row.id, 'duplicate', true);
      try {
        const r = await fetch(`/api/ads/${this.level}/${row.id}/duplicate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deep_copy: true }),
        });
        const data = await r.json();
        if (!data.ok) { this.toastError('Duplicate failed', data.message || data.error || 'unknown'); return; }
        this.toastInfo('Duplicated (paused)', `New ${noun} created OFF. Refresh to see it.`);
        this.refreshUsage();
      } catch (e) {
        this.toastError('Duplicate error', String(e));
      } finally {
        this._setPending(row.id, 'duplicate', false);
      }
    },

    // ---------- Strategy advisor (suggest-only) ----------
    async openStrategy() {
      this.strategy.open = true;
      this.loadProfile();
      if (!this.strategy.data && !this.strategy.loading) await this.runStrategy();
    },
    closeStrategy() { this.strategy.open = false; },
    setStrategyTab(tab) {
      if (this.strategy.tab === tab) return;
      this.strategy.tab = tab;
      this.runActiveTabAI();
    },
    runActiveTabAI() {
      if (!this.strategy.data) return;
      if (this.strategy.tab === 'briefing') {
        if (!this.strategy.briefing && !this.strategy.briefingLoading) this.runBriefing();
      } else if (this.strategy.tab === 'analysis') {
        if (!this.strategy.narrative && !this.strategy.aiLoading) this.runStrategyNarrative();
      }
    },
    setStrategyWindow(w) {
      if (this.strategy.window === w) return;
      this.strategy.window = w;
      this.runStrategy();
    },
    async runStrategy() {
      this.strategy.loading = true;
      this.strategy.error = '';
      this.strategy.narrative = null;
      this.strategy.briefing = null;
      try {
        const r = await fetch('/api/strategy/analyze', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ window: this.strategy.window }),
        });
        const data = await r.json();
        if (!data.ok) { this.strategy.error = data.message || data.error || 'Analysis failed'; this.strategy.data = null; return; }
        this.strategy.data = data;
        this.runActiveTabAI();
      } catch (e) {
        this.strategy.error = String(e);
      } finally {
        this.strategy.loading = false;
        this.refreshUsage();
      }
    },
    async runBriefing() {
      this.strategy.briefingLoading = true;
      try {
        const r = await fetch('/api/strategy/briefing', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const data = await r.json();
        if (data.ok) this.strategy.briefing = data.briefing;
        else this.strategy.briefing = { error: data.message || data.error || 'AI unavailable' };
      } catch (e) {
        this.strategy.briefing = { error: String(e) };
      } finally {
        this.strategy.briefingLoading = false;
      }
    },
    async copyBriefing() {
      const b = this.strategy.briefing;
      if (!b || b.error) return;
      const lines = [];
      if (b.headline) lines.push(b.headline, '');
      if (b.standing_today) lines.push(b.standing_today, '');
      if (b.confident_actions && b.confident_actions.length) {
        lines.push('CONFIDENT ACTIONS:');
        b.confident_actions.forEach((a) => {
          lines.push(`- [${a.confidence}] ${a.title} — ${a.why}` + (a.what_to_wait_for ? ` (wait: ${a.what_to_wait_for})` : ''));
        });
        lines.push('');
      }
      if (b.opportunities && b.opportunities.length) { lines.push('OPPORTUNITIES:'); b.opportunities.forEach((o) => lines.push(`- ${o}`)); lines.push(''); }
      if (b.watch && b.watch.length) { lines.push('WATCH (not yet confident):'); b.watch.forEach((w) => lines.push(`- ${w}`)); lines.push(''); }
      if (b.do_not_act && b.do_not_act.length) { lines.push("DON'T OVERREACT TO:"); b.do_not_act.forEach((n) => lines.push(`- ${n}`)); lines.push(''); }
      if (b.growth_moves && b.growth_moves.length) { lines.push('GROWTH MOVES:'); b.growth_moves.forEach((g) => lines.push(`- [${g.impact}/${g.effort}] ${g.title} — ${g.why}`)); }
      const text = lines.join('\n').trim();
      this._copyText(text);
    },
    chatSuggest(q) { this.strategy.chat.input = q; this.sendChat(); },
    async sendChat(overrideMessage) {
      const c = this.strategy.chat;
      const isAuto = overrideMessage != null;
      const message = (isAuto ? String(overrideMessage) : (c.input || '')).trim();
      if (!message || c.loading) return;
      if (!this.strategy.data) { c.error = 'Run an analysis first so the advisor has data to reason over.'; return; }
      if (!c.sessionId) c.sessionId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      c.error = '';
      const history = c.messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
      // Auto-continue messages (after an approve/reject) are shown as a subtle system line, not a user bubble.
      c.messages.push({ role: 'user', content: message, system: isAuto });
      if (!isAuto) c.input = '';
      c.loading = true;
      this.$nextTick(() => this.scrollChatBottom());
      let asstIdx = -1;
      const ensureAsst = () => {
        if (asstIdx < 0) { asstIdx = c.messages.push({ role: 'assistant', content: '', model: null, streaming: true, tools: [], previews: [], approvals: [] }) - 1; }
        return asstIdx;
      };
      try {
        const r = await fetch('/api/strategy/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, history, stream: true, sessionId: c.sessionId }),
        });
        if (!r.body || typeof r.body.getReader !== 'function') {
          const data = await r.json().catch(() => ({}));
          if (data.ok) {
            const i = ensureAsst(); c.messages[i].content = data.reply; c.messages[i].model = data.model; c.messages[i].streaming = false;
            (data.approvals || []).forEach((a) => { a.status = 'pending'; a.armed = data.advisorWritesEnabled === true; c.messages[i].approvals.push(a); });
            this.finalizeAssistant(c.messages[i]);
          }
          else c.error = data.message || data.error || 'Advisor unavailable';
          return;
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload) continue;
            let ev; try { ev = JSON.parse(payload); } catch { continue; }
            if (ev.type === 'delta') { const i = ensureAsst(); c.messages[i].content += ev.text; this.scrollChatBottom(); }
            else if (ev.type === 'tool') {
              const m = c.messages[ensureAsst()];
              if (ev.phase === 'start') {
                m.tools.push({ name: ev.name, args: ev.args || {}, label: this.toolLabel(ev.name, ev.args), status: 'running', summary: '', expanded: false });
              } else {
                const t = [...m.tools].reverse().find((x) => x.name === ev.name && x.status === 'running');
                if (t) { t.status = ev.ok ? 'done' : 'failed'; t.summary = ev.summary || ''; }
                else m.tools.push({ name: ev.name, args: {}, label: this.toolLabel(ev.name, {}), status: ev.ok ? 'done' : 'failed', summary: ev.summary || '', expanded: false });
                if (ev.preview && ev.preview.iframe) m.previews.push(ev.preview);
              }
              this.scrollChatBottom();
            }
            else if (ev.type === 'approval') {
              const m = c.messages[ensureAsst()];
              const a = ev.approval || {};
              a.status = 'pending';
              a.armed = ev.armed === true;
              m.approvals.push(a);
              this.scrollChatBottom();
            }
            else if (ev.type === 'done') { const i = ensureAsst(); c.messages[i].model = ev.model; c.messages[i].streaming = false; this.finalizeAssistant(c.messages[i]); }
            else if (ev.type === 'error') { c.error = ev.message || ev.error || 'Advisor unavailable'; }
          }
        }
        if (asstIdx >= 0) c.messages[asstIdx].streaming = false;
        if (asstIdx < 0 && !c.error) c.error = 'No response from advisor.';
      } catch (e) {
        if (asstIdx >= 0) c.messages[asstIdx].streaming = false;
        c.error = String(e);
      } finally {
        c.loading = false;
        this.refreshUsage();
        this.$nextTick(() => this.scrollChatBottom());
      }
    },
    scrollChatBottom() {
      const el = document.getElementById('advisor-chat-scroll');
      if (el) el.scrollTop = el.scrollHeight;
    },
    // Tier D: pull the trailing "[FOLLOWUPS] a | b | c" line out of the answer into clickable chips.
    finalizeAssistant(m) {
      if (!m || typeof m.content !== 'string') return;
      const idx = m.content.search(/\**\s*\[FOLLOWUPS\]/i);
      if (idx < 0) { m.followups = m.followups || []; return; }
      const tail = m.content.slice(idx).replace(/\**\s*\[FOLLOWUPS\][:\-\s]*/i, '');
      m.content = m.content.slice(0, idx).replace(/\s+$/, '');
      m.followups = tail.split(/\s*\|\s*/).map((s) => s.replace(/[\s*_>#-]+$/g, '').trim()).filter((s) => s.length > 2).slice(0, 3);
    },
    useFollowup(q) {
      const c = this.strategy.chat;
      if (c.loading || !q) return;
      c.input = q;
      this.sendChat();
    },
    // Tier A: load/save the standing operator brief (account-level + per-campaign goals).
    async loadProfile() {
      try {
        const r = await fetch('/api/strategy/profile');
        const data = await r.json().catch(() => ({}));
        if (data.ok) {
          const p = data.profile || {};
          this.strategy.profile = {
            riskTolerance: p.riskTolerance || 'balanced',
            brandVoice: p.brandVoice || '', notes: p.notes || '',
            campaigns: Array.isArray(p.campaigns) ? p.campaigns.map((c) => ({
              name: c.name || '', goal: c.goal || '', targetCpa: c.targetCpa || '',
              targetRoas: c.targetRoas || '', sacred: !!c.sacred, notes: c.notes || '',
            })) : [],
          };
          this.strategy.armed = data.armed === true;
          this.strategy.envForced = data.envForced === true;
        }
      } catch (e) { /* non-fatal */ }
    },
    async saveProfile() {
      const s = this.strategy;
      s.briefSaving = true; s.briefSaved = false;
      try {
        const p = s.profile;
        const r = await fetch('/api/strategy/profile', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            riskTolerance: p.riskTolerance, brandVoice: p.brandVoice, notes: p.notes,
            campaigns: (p.campaigns || []).filter((c) => (c.name || '').trim()),
          }),
        });
        const data = await r.json().catch(() => ({}));
        if (data.ok) { s.briefSaved = true; setTimeout(() => { s.briefSaved = false; }, 2500); }
        else { s.chat.error = data.message || 'Could not save brief'; }
      } catch (e) { s.chat.error = String(e); }
      finally { s.briefSaving = false; }
    },
    addCampaignGoal(name = '') {
      this.strategy.profile.campaigns.push({ name, goal: '', targetCpa: '', targetRoas: '', sacred: false, notes: '' });
    },
    removeCampaignGoal(i) { this.strategy.profile.campaigns.splice(i, 1); },
    // Campaign names from the loaded snapshot, minus ones already in the brief (for the picker).
    get snapshotCampaignNames() {
      const used = new Set((this.strategy.profile.campaigns || []).map((c) => (c.name || '').trim()));
      return ((this.strategy.data && this.strategy.data.campaigns) || [])
        .map((c) => c.name).filter((n) => n && !used.has(n));
    },
    // Arm/disarm real execution at runtime (per-action approval still required).
    async toggleArm() {
      const s = this.strategy;
      if (s.envForced || s.armBusy) return;
      s.armBusy = true;
      const next = !s.armed;
      try {
        const r = await fetch('/api/strategy/arm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ armed: next }),
        });
        const data = await r.json().catch(() => ({}));
        if (data.ok) { s.armed = data.armed === true; }
      } catch (e) { s.chat.error = String(e); }
      finally { s.armBusy = false; }
    },
    toolLabel(name, args) {
      const verbs = {
        get_fresh_insights: 'Fetching live insights',
        get_change_history: 'Reading change history',
        get_ad_preview: 'Loading ad preview',
        re_analyze: 'Re-analyzing account',
        get_comments: 'Reading comments',
      };
      let label = verbs[name] || name;
      const hint = args && (args.name || (args.level === 'account' ? 'account' : '') || args.scope || args.window);
      if (hint) label += ` · ${hint}`;
      if (args && args.breakdown && args.breakdown !== 'none') label += ` (${args.breakdown})`;
      return label;
    },
    toolIcon(name) {
      const p = {
        get_fresh_insights: 'M4 19V5m0 14h16M8 16l3-4 3 2 4-6',
        get_change_history: 'M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z',
        get_ad_preview: 'M4 5h16v14H4zM4 15l4-4 3 3 4-5 5 6',
        re_analyze: 'M4 4v6h6M20 20v-6h-6M5 13a7 7 0 0012 4M19 11a7 7 0 00-12-4',
        get_comments: 'M8 10h8M8 14h5M21 12a8 8 0 01-11.6 7.1L4 20l1-4.3A8 8 0 1121 12z',
      }[name] || 'M5 12h14';
      return `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="${p}"/></svg>`;
    },
    prettyArgs(args) {
      if (!args || typeof args !== 'object') return '(no arguments)';
      const keys = Object.keys(args);
      if (!keys.length) return '(no arguments)';
      return keys.map((k) => `${k}: ${typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]}`).join('\n');
    },
    async approveAction(mi, ai) {
      const c = this.strategy.chat;
      const m = c.messages[mi]; if (!m || !m.approvals) return;
      const a = m.approvals[ai]; if (!a || a.status !== 'pending' || c.loading) return;
      a.status = 'approving';
      a.decidedOutcome = null;
      try {
        const r = await fetch('/api/strategy/tool/execute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: a.tool, args: a.args, sessionId: c.sessionId, decision: 'approve' }),
        });
        const data = await r.json().catch(() => ({}));
        if (data.ok) { a.status = 'applied'; a.resultMsg = 'Applied to Meta'; a.decidedOutcome = `"${a.summary}" was APPLIED successfully`; }
        else if (data.error === 'advisor_writes_disabled') { a.status = 'dryrun'; a.resultMsg = 'Live actions are off — nothing sent to Meta'; a.decidedOutcome = `"${a.summary}" was approved but Live actions are OFF, so nothing was sent to Meta (dry-run)`; }
        else { a.status = 'failed'; a.resultMsg = (data.result && data.result.message) || data.message || data.error || 'Failed'; a.decidedOutcome = `"${a.summary}" did NOT apply (${a.resultMsg})`; }
      } catch (e) { a.status = 'failed'; a.resultMsg = String(e); a.decidedOutcome = `"${a.summary}" failed (${String(e)})`; }
      this.$nextTick(() => this.scrollChatBottom());
      await this.continueAfterApprovals(mi);
    },
    async rejectAction(mi, ai) {
      const c = this.strategy.chat;
      const m = c.messages[mi]; const a = m && m.approvals && m.approvals[ai];
      if (!a || a.status !== 'pending' || c.loading) return;
      a.status = 'rejected';
      a.decidedOutcome = `"${a.summary}" was REJECTED — do not take that action`;
      try {
        await fetch('/api/strategy/tool/execute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: a.tool, args: a.args, sessionId: c.sessionId, decision: 'reject' }),
        });
      } catch {}
      this.$nextTick(() => this.scrollChatBottom());
      await this.continueAfterApprovals(mi);
    },
    // Only resume the AI once EVERY card in this message is decided, then send ONE combined turn —
    // otherwise rejecting card #1 makes the AI reply while card #2 is still waiting on the operator.
    async continueAfterApprovals(mi) {
      const c = this.strategy.chat;
      const m = c.messages[mi]; if (!m || !m.approvals) return;
      if (m.approvals.some((x) => x.status === 'pending' || x.status === 'approving')) return; // still waiting
      if (m.followupSent) return; // guard against double-continue
      m.followupSent = true;
      const decisions = m.approvals.map((x) => x.decidedOutcome).filter(Boolean);
      if (!decisions.length) return;
      const body = decisions.length === 1
        ? `[Operator decision] ${decisions[0]}. Briefly confirm what changed (or didn't) and what to watch next. Do not re-propose any rejected action.`
        : `[Operator decisions on ${decisions.length} proposals]\n- ${decisions.join('\n- ')}\nBriefly confirm the net result and what to watch next. Do not re-propose any rejected action.`;
      await this.sendChat(body);
    },
    renderMd(text) {
      const esc = String(text || '')
        .replace(/\**\s*\[FOLLOWUPS\][\s\S]*$/i, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const lines = esc.split('\n');
      let html = ''; let inList = false;
      const inline = (s) => s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-meta-gray-100 text-[11px]">$1</code>');
      for (let raw of lines) {
        const line = raw.trim();
        if (/^#{1,6}\s+/.test(line)) {
          if (inList) { html += '</ul>'; inList = false; }
          html += `<div class="font-semibold mt-2">${inline(line.replace(/^#{1,6}\s+/, ''))}</div>`;
        } else if (/^[-*]\s+/.test(line)) {
          if (!inList) { html += '<ul class="list-disc list-inside space-y-0.5 my-1">'; inList = true; }
          html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`;
        } else if (line === '') {
          if (inList) { html += '</ul>'; inList = false; }
          html += '<div class="h-2"></div>';
        } else {
          if (inList) { html += '</ul>'; inList = false; }
          html += `<div>${inline(line)}</div>`;
        }
      }
      if (inList) html += '</ul>';
      return html;
    },
    async _copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        this.strategy.copied = true;
        setTimeout(() => { this.strategy.copied = false; }, 1800);
      } catch (e) {
        console.error('[strategy] copy briefing failed', e);
      }
    },
    async runStrategyNarrative() {
      this.strategy.aiLoading = true;
      try {
        const r = await fetch('/api/strategy/narrative', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const data = await r.json();
        if (data.ok) this.strategy.narrative = data.narrative;
        else this.strategy.narrative = { error: data.message || data.error || 'AI unavailable' };
      } catch (e) {
        this.strategy.narrative = { error: String(e) };
      } finally {
        this.strategy.aiLoading = false;
      }
    },
    sevClass(sev) {
      if (sev === 'high') return 'bg-red-50 text-red-700 border-red-200';
      if (sev === 'medium') return 'bg-yellow-50 text-yellow-700 border-yellow-200';
      return 'bg-blue-50 text-blue-700 border-blue-200';
    },
    strategyChip(s) {
      const map = {
        consolidate: 'Consolidate', scale_vertical: 'Scale ↑ (budget)', scale_horizontal: 'Scale → (duplicate)',
        duplicate: 'Duplicate', pause: 'Pause', creative_refresh: 'Refresh creative',
        daypart_weight: 'Day weighting', fix_tracking: 'Fix tracking', hold: 'Hold', stop_loss: 'Stop-loss',
      };
      return map[s] || s;
    },
    fmtRoasX(v) { return v == null ? '—' : Number(v).toFixed(2) + 'x'; },
    fmtPctSigned(v) {
      if (v == null) return '—';
      const n = Number(v);
      return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
    },

    // ---- Daily Briefing helpers ----
    confClass(tier) {
      if (tier === 'high') return 'bg-green-100 text-green-800 border-green-300';
      if (tier === 'medium') return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      if (tier === 'low') return 'bg-gray-100 text-gray-600 border-gray-300';
      return 'bg-gray-50 text-gray-400 border-gray-200';
    },
    actionChip(a) {
      const map = {
        scale_up: '▲ Scale up', scale_down: '▼ Scale down', pause: '■ Pause / kill',
        duplicate: '⎘ Duplicate', refresh_creative: '✎ Refresh creative',
        narrow_targeting: '⊖ Trim segment', expand_targeting: '⊕ Expand segment',
        cost_cap_candidate: '◈ Cost-cap candidate', hold: '= Hold', watch: '◷ Watch',
      };
      return map[a] || a;
    },
    actionClass(a) {
      if (a === 'pause' || a === 'scale_down' || a === 'narrow_targeting') return 'bg-red-50 text-red-700 border-red-200';
      if (a === 'scale_up' || a === 'expand_targeting' || a === 'duplicate') return 'bg-green-50 text-green-700 border-green-200';
      if (a === 'refresh_creative' || a === 'cost_cap_candidate') return 'bg-yellow-50 text-yellow-700 border-yellow-200';
      if (a === 'watch') return 'bg-blue-50 text-blue-700 border-blue-200';
      return 'bg-gray-50 text-gray-600 border-gray-200';
    },
    verdictClass(v) {
      if (v === 'better' || v === 'healthy') return 'text-green-700';
      if (v === 'worse' || v === 'saturating' || v === 'anomalous') return 'text-red-700';
      if (v === 'watch') return 'text-yellow-700';
      return 'text-meta-gray-600';
    },
    zClass(z) {
      if (z == null) return 'text-meta-gray-500';
      const a = Math.abs(Number(z));
      if (a >= 2) return 'text-red-600 font-semibold';
      if (a >= 1) return 'text-yellow-700';
      return 'text-green-700';
    },
    fmtZ(z) { return z == null ? '—' : (Number(z) > 0 ? '+' : '') + Number(z).toFixed(1) + 'σ'; },
    fmtCI(lo, hi) { return (lo == null || hi == null) ? '' : `$${lo}–$${hi}`; },
    fmtInt(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString(); },
    growthApplClass(a) {
      if (a === 'foundational') return 'bg-purple-50 text-purple-700 border-purple-200';
      if (a === 'primary') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      if (a === 'secondary' || a === 'ready') return 'bg-teal-50 text-teal-700 border-teal-200';
      if (a === 'gated') return 'bg-amber-50 text-amber-700 border-amber-200';
      if (a === 'avoid') return 'bg-red-50 text-red-600 border-red-200';
      return 'bg-gray-50 text-gray-600 border-gray-200';
    },

    toastError(title, message) { this.toast = { show: true, type: 'error', title, message }; setTimeout(() => (this.toast.show = false), 7000); },
    toastInfo(title, message) { this.toast = { show: true, type: 'info', title, message }; setTimeout(() => (this.toast.show = false), 4000); },
  };
}
