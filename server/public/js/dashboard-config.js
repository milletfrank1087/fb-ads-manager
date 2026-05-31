/* Dashboard static configuration & data — extracted from app.js for separation
   of concerns. Loaded as a classic script BEFORE app.js, so these top-level
   consts live in the shared global scope and are referenced unchanged by the
   dashboard() factory. */
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
