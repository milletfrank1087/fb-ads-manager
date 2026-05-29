const COLUMN_GROUPS = [
  {
    id: 'delivery',
    label: 'Delivery',
    columns: [
      { id: 'delivery', field: 'effective_status', label: 'Delivery', align: 'left', kind: 'badge', tip: 'Current delivery status from Meta (Active / Off / In review). Use the Off/On switch in the first column to pause or resume.' },
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    columns: [
      { id: 'spend', field: 'spend', label: 'Amount spent', align: 'right', kind: 'money', tip: 'Total amount spent in the selected date range, in your account currency.' },
      { id: 'reach', field: 'reach', label: 'Reach', align: 'right', kind: 'int', tip: 'Number of unique people who saw your ads at least once.' },
      { id: 'impressions', field: 'impressions', label: 'Impressions', align: 'right', kind: 'int', tip: 'Total number of times your ads were shown, including repeat views.' },
      { id: 'cpm', field: 'cpm', label: 'CPM', align: 'right', kind: 'money', subtle: 'cpm', tip: 'Cost per 1,000 impressions = spend ÷ impressions × 1,000. Lower is cheaper reach.' },
      { id: 'unique_inline_link_click_ctr', field: 'unique_inline_link_click_ctr', label: 'Unique CTR', align: 'right', kind: 'pct', subtle: 'link ctr', tip: 'Unique link click-through rate = unique link clicks ÷ reach. Higher means more compelling creative.' },
      { id: 'unique_inline_link_clicks', field: 'unique_inline_link_clicks', label: 'Unique link clicks', align: 'right', kind: 'int', tip: 'Number of unique people who clicked a link in your ad.' },
      { id: 'cost_per_inline_link_click', field: 'cost_per_inline_link_click', label: 'CPC (link)', align: 'right', kind: 'money', subtle: 'cpc', tip: 'Cost per link click = spend ÷ link clicks.' },
      { id: 'frequency', field: 'frequency', label: 'Frequency', align: 'right', kind: 'float2', tip: 'Average number of times each person saw your ad = impressions ÷ reach. High frequency can cause fatigue.' },
    ],
  },
  {
    id: 'engagement',
    label: 'Engagement',
    columns: [
      { id: 'post_comments', field: 'post_comments', label: 'Post comments', align: 'right', kind: 'int', tip: 'Comments left on the ad\'s post. Open the Comments manager to review, reply, hide or delete them.' },
      { id: 'post_engagements', field: 'post_engagements', label: 'Post engagements', align: 'right', kind: 'int', tip: 'All engagements on the post: reactions, comments, shares, photo views and link clicks.' },
      { id: 'link_clicks', field: 'link_clicks', label: 'Link clicks', align: 'right', kind: 'int', tip: 'Total clicks on links in your ad, including repeat clicks by the same person.' },
      { id: 'landing_page_views_total', field: 'landing_page_views_total', label: 'Landing page views', align: 'right', kind: 'int', tip: 'Times people loaded your landing page after clicking (requires the Meta pixel).' },
      { id: 'landing_page_views_app', field: 'landing_page_views_app', label: 'App landing views', align: 'right', kind: 'int', tip: 'Landing page views attributed to in-app placements.' },
      { id: 'landing_page_views_website', field: 'landing_page_views_website', label: 'Website landing views', align: 'right', kind: 'int', tip: 'Landing page views attributed to website placements.' },
      { id: 'cost_per_landing_page_view', field: 'cost_per_landing_page_view', label: 'Cost / landing view', align: 'right', kind: 'money', tip: 'Spend ÷ landing page views.' },
    ],
  },
  {
    id: 'cart',
    label: 'Adds to cart',
    columns: [
      { id: 'atc_total', field: 'atc_total', label: 'Adds to cart', align: 'right', kind: 'int', tip: 'Total add-to-cart events across all sources (website, app, offline, Meta).' },
      { id: 'atc_app', field: 'atc_app', label: 'In-app adds to cart', align: 'right', kind: 'int', tip: 'Add-to-cart events tracked inside your app.' },
      { id: 'atc_website', field: 'atc_website', label: 'Website adds to cart', align: 'right', kind: 'int', tip: 'Add-to-cart events tracked on your website via the pixel.' },
      { id: 'atc_offline', field: 'atc_offline', label: 'Offline adds to cart', align: 'right', kind: 'int', tip: 'Add-to-cart events uploaded through offline event sets.' },
      { id: 'atc_meta', field: 'atc_meta', label: 'Meta adds to cart', align: 'right', kind: 'int', tip: 'Add-to-cart events that happened on Meta surfaces (e.g. Shops).' },
      { id: 'cost_per_add_to_cart', field: 'cost_per_add_to_cart', label: 'Cost / add to cart', align: 'right', kind: 'money', tip: 'Spend ÷ total adds to cart.' },
    ],
  },
  {
    id: 'checkout',
    label: 'Checkouts initiated',
    columns: [
      { id: 'ic_total', field: 'ic_total', label: 'Checkouts initiated', align: 'right', kind: 'int', tip: 'Total checkouts started across all sources.' },
      { id: 'ic_app', field: 'ic_app', label: 'In-app checkouts', align: 'right', kind: 'int', tip: 'Checkouts started inside your app.' },
      { id: 'ic_website', field: 'ic_website', label: 'Website checkouts', align: 'right', kind: 'int', tip: 'Checkouts started on your website via the pixel.' },
      { id: 'ic_offline', field: 'ic_offline', label: 'Offline checkouts', align: 'right', kind: 'int', tip: 'Checkouts uploaded through offline event sets.' },
      { id: 'ic_meta', field: 'ic_meta', label: 'Meta checkouts', align: 'right', kind: 'int', tip: 'Checkouts that happened on Meta surfaces.' },
      { id: 'cost_per_initiate_checkout', field: 'cost_per_initiate_checkout', label: 'Cost / checkout', align: 'right', kind: 'money', tip: 'Spend ÷ checkouts initiated.' },
    ],
  },
  {
    id: 'purchases',
    label: 'Purchases',
    columns: [
      { id: 'purchases_total', field: 'purchases_total', label: 'Purchases', align: 'right', kind: 'int', tip: 'Total purchases across all sources — your primary conversion count.' },
      { id: 'purchases_app', field: 'purchases_app', label: 'In-app purchases', align: 'right', kind: 'int', tip: 'Purchases completed inside your app.' },
      { id: 'purchases_website', field: 'purchases_website', label: 'Website purchases', align: 'right', kind: 'int', tip: 'Purchases completed on your website via the pixel.' },
      { id: 'purchases_offline', field: 'purchases_offline', label: 'Offline purchases', align: 'right', kind: 'int', tip: 'Purchases uploaded through offline event sets.' },
      { id: 'purchases_meta', field: 'purchases_meta', label: 'Meta purchases', align: 'right', kind: 'int', tip: 'Purchases that happened on Meta surfaces (e.g. Shops).' },
      { id: 'cost_per_purchase', field: 'cost_per_purchase', label: 'Cost / purchase', align: 'right', kind: 'money', tip: 'Spend ÷ purchases — your effective cost per acquisition (CPA).' },
    ],
  },
  {
    id: 'revenue',
    label: 'Revenue / ROAS',
    columns: [
      { id: 'purchase_value_total', field: 'purchase_value_total', label: 'Purchase value', align: 'right', kind: 'money', tip: 'Total revenue (conversion value) attributed to purchases across all sources.' },
      { id: 'purchase_value_app', field: 'purchase_value_app', label: 'In-app purchase value', align: 'right', kind: 'money', tip: 'Revenue from in-app purchases.' },
      { id: 'purchase_value_website', field: 'purchase_value_website', label: 'Website purchase value', align: 'right', kind: 'money', tip: 'Revenue from website purchases.' },
      { id: 'purchase_value_offline', field: 'purchase_value_offline', label: 'Offline purchase value', align: 'right', kind: 'money', tip: 'Revenue from offline-uploaded purchases.' },
      { id: 'purchase_value_meta', field: 'purchase_value_meta', label: 'Meta purchase value', align: 'right', kind: 'money', tip: 'Revenue from purchases on Meta surfaces.' },
      { id: 'purchase_roas_total', field: 'purchase_roas_total', label: 'Purchase ROAS', align: 'right', kind: 'roas', tip: 'Return on ad spend = purchase value ÷ spend. 3.0x means €3 back per €1 spent.' },
      { id: 'purchase_roas_website', field: 'purchase_roas_website', label: 'Website ROAS', align: 'right', kind: 'roas', tip: 'ROAS from website purchases only.' },
      { id: 'purchase_roas_app', field: 'purchase_roas_app', label: 'In-app ROAS', align: 'right', kind: 'roas', tip: 'ROAS from in-app purchases only.' },
    ],
  },
];

const ORDERED_COLUMNS = COLUMN_GROUPS.flatMap((g) => g.columns);

const DEFAULT_VISIBLE_COLUMN_IDS = new Set([
  'delivery',
  'spend',
  'reach',
  'impressions',
  'post_comments',
  'cpm',
  'unique_inline_link_click_ctr',
  'unique_inline_link_clicks',
  'cost_per_inline_link_click',
  'landing_page_views_total',
]);

const BUILT_IN_PRESETS = [
  {
    id: 'default',
    name: 'Default',
    columns: Array.from(DEFAULT_VISIBLE_COLUMN_IDS),
  },
  {
    id: 'performance',
    name: 'Performance',
    columns: ['delivery', 'spend', 'reach', 'impressions', 'cpm', 'unique_inline_link_click_ctr', 'unique_inline_link_clicks', 'cost_per_inline_link_click', 'frequency', 'post_comments', 'post_engagements'],
  },
  {
    id: 'conversions',
    name: 'Conversions',
    columns: [
      'delivery',
      'spend',
      'reach',
      'impressions',
      'post_comments',
      'cpm',
      'unique_inline_link_click_ctr',
      'unique_inline_link_clicks',
      'cost_per_inline_link_click',
      'landing_page_views_total',
      'landing_page_views_app',
      'landing_page_views_website',
      'cost_per_landing_page_view',
      'atc_total',
      'cost_per_add_to_cart',
      'ic_total',
      'cost_per_initiate_checkout',
      'purchases_total',
      'cost_per_purchase',
      'purchase_value_total',
      'purchase_roas_total',
    ],
  },
  {
    id: 'revenue',
    name: 'Revenue / ROAS',
    columns: ['delivery', 'spend', 'purchases_total', 'purchase_value_total', 'purchase_value_website', 'purchase_value_app', 'purchase_roas_total', 'purchase_roas_website', 'purchase_roas_app', 'cost_per_purchase'],
  },
  {
    id: 'channels',
    name: 'By channel',
    columns: ['delivery', 'spend', 'purchases_app', 'purchases_website', 'purchases_offline', 'purchases_meta', 'purchase_value_app', 'purchase_value_website', 'purchase_value_offline', 'purchase_value_meta'],
  },
  {
    id: 'all',
    name: 'All columns',
    columns: ORDERED_COLUMNS.map((c) => c.id),
  },
];

const LS_COLS = 'gfm.visibleColumns.v3';
const LS_PRESETS = 'gfm.customPresets.v1';
const LS_ACTIVE_PRESET = 'gfm.activePresetId.v1';
const LS_FILTER_MODE = 'gfm.filterMode.v1';
const LS_AUTO_REFRESH = 'gfm.autoRefresh.v1';

const STALE_WARN_SEC = 10 * 60;
const STALE_OLD_SEC = 30 * 60;
const AUTO_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const SAFETY_USAGE_PCT_BLOCK = 50;

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
    },
    strategyWindows: [
      { id: 'last_7d', label: 'Last 7 days' },
      { id: 'last_14d', label: 'Last 14 days' },
      { id: 'last_28d', label: 'Last 28 days' },
      { id: 'last_30d', label: 'Last 30 days' },
      { id: 'last_90d', label: 'Last 90 days' },
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
      } else if (!this.strategy.narrative && !this.strategy.aiLoading) {
        this.runStrategyNarrative();
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
      if (b.do_not_act && b.do_not_act.length) { lines.push("DON'T OVERREACT TO:"); b.do_not_act.forEach((n) => lines.push(`- ${n}`)); }
      const text = lines.join('\n').trim();
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

    toastError(title, message) { this.toast = { show: true, type: 'error', title, message }; setTimeout(() => (this.toast.show = false), 7000); },
    toastInfo(title, message) { this.toast = { show: true, type: 'info', title, message }; setTimeout(() => (this.toast.show = false), 4000); },
  };
}
