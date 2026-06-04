export const VALID_DATE_PRESETS = new Set([
  'today',
  'yesterday',
  'this_week_mon_today',
  'this_week_sun_today',
  'last_7d',
  'last_14d',
  'last_28d',
  'last_30d',
  'last_90d',
  'last_month',
  'this_month',
  'last_quarter',
  'this_quarter',
  'last_year',
  'this_year',
  'maximum',
]);

export const CAMPAIGN_ENTITY_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'objective',
  'daily_budget',
  'lifetime_budget',
  'buying_type',
  'bid_strategy',
  'start_time',
  'stop_time',
  'created_time',
  'updated_time',
].join(',');

export const ADSET_ENTITY_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'campaign_id',
  'optimization_goal',
  'billing_event',
  'bid_strategy',
  'bid_amount',
  'daily_budget',
  'lifetime_budget',
  'learning_stage_info',
  'promoted_object',
  'targeting{geo_locations,age_min,age_max,genders,custom_audiences}',
  'start_time',
  'end_time',
  'created_time',
  'updated_time',
].join(',');

export const AD_ENTITY_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'campaign_id',
  'adset_id',
  'creative{id,thumbnail_url,title,body,effective_object_story_id,object_story_id}',
  'created_time',
  'updated_time',
].join(',');

export const INSIGHTS_FIELDS = [
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'spend',
  'reach',
  'impressions',
  'frequency',
  'cpm',
  'inline_link_clicks',
  'unique_inline_link_clicks',
  'unique_inline_link_click_ctr',
  'cost_per_inline_link_click',
  'actions',
  'action_values',
  'cost_per_action_type',
  'purchase_roas',
  'website_purchase_roas',
  'mobile_app_purchase_roas',
].join(',');

const matchAny = (list) => (a) => list.includes(a.action_type);
const matchAnyPrefix = (prefixes) => (a) => prefixes.some((p) => a.action_type === p || a.action_type?.startsWith(p));

export const ACTION_GROUPS = {
  postComments: { match: matchAny(['comment', 'post_comment', 'onsite_comment']) },
  postEngagements: { match: matchAny(['post_engagement']) },
  linkClicks: { match: matchAny(['link_click']) },

  landingPageViewsTotal: { match: matchAny(['landing_page_view', 'omni_landing_page_view']) },
  landingPageViewsApp: { match: matchAnyPrefix(['mobile_app_landing_page_view', 'app_custom_event.fb_mobile_landing_page_view']) },
  landingPageViewsWebsite: { match: matchAny(['offsite_conversion.fb_pixel_landing_page_view']) },

  addToCartTotal: { match: matchAny(['omni_add_to_cart']) },
  addToCartApp: { match: matchAnyPrefix(['mobile_app_add_to_cart', 'app_custom_event.fb_mobile_add_to_cart']) },
  addToCartWebsite: { match: matchAny(['offsite_conversion.fb_pixel_add_to_cart']) },
  addToCartOffline: { match: matchAnyPrefix(['offline_conversion.add_to_cart']) },
  addToCartMeta: { match: matchAny(['onsite_conversion.add_to_cart']) },

  initiateCheckoutTotal: { match: matchAny(['omni_initiated_checkout']) },
  initiateCheckoutApp: { match: matchAnyPrefix(['mobile_app_initiate_checkout', 'app_custom_event.fb_mobile_initiated_checkout']) },
  initiateCheckoutWebsite: { match: matchAny(['offsite_conversion.fb_pixel_initiate_checkout']) },
  initiateCheckoutOffline: { match: matchAnyPrefix(['offline_conversion.initiate_checkout']) },
  initiateCheckoutMeta: { match: matchAny(['onsite_conversion.initiate_checkout']) },

  purchasesTotal: { match: matchAny(['omni_purchase']) },
  purchasesApp: { match: matchAnyPrefix(['mobile_app_purchase', 'app_custom_event.fb_mobile_purchase']) },
  purchasesWebsite: { match: matchAny(['offsite_conversion.fb_pixel_purchase']) },
  purchasesOffline: { match: matchAnyPrefix(['offline_conversion.purchase']) },
  purchasesMeta: { match: matchAny(['onsite_conversion.purchase']) },
};

export const ROAS_FIELDS = {
  purchaseRoasTotal: { source: 'purchase_roas', preferred: ['omni_purchase'] },
  purchaseRoasWebsite: { source: 'website_purchase_roas', preferred: ['offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'] },
  purchaseRoasApp: { source: 'mobile_app_purchase_roas', preferred: [] },
};

export const COST_PER_ACTION_MAP = {
  costPerLandingPageView: ['landing_page_view', 'omni_landing_page_view'],
  costPerAddToCart: ['omni_add_to_cart', 'add_to_cart'],
  costPerInitiateCheckout: ['omni_initiated_checkout', 'initiate_checkout'],
  costPerPurchase: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'],
};

function sumByMatcher(actions, matcher) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    if (!a || !matcher(a)) continue;
    const v = Number(a.value);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

function pickFirstByActionType(arr, preferred) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  for (const wanted of preferred) {
    const hit = arr.find((e) => e?.action_type === wanted);
    if (hit) {
      const v = Number(hit.value);
      return Number.isFinite(v) ? v : null;
    }
  }
  const v = Number(arr[0]?.value);
  return Number.isFinite(v) ? v : null;
}

function pickByActionTypes(arr, allowedTypes) {
  if (!Array.isArray(arr)) return null;
  for (const a of arr) {
    if (allowedTypes.includes(a?.action_type)) {
      const v = Number(a.value);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

export function insightsHadDeliveryFilter(level = 'campaign') {
  const field =
    level === 'adset' ? 'adset.impressions' :
    level === 'ad' ? 'ad.impressions' :
    'campaign.impressions';
  return JSON.stringify([{ field, operator: 'GREATER_THAN', value: 0 }]);
}

export function normalizeInsightsRow(row, level = 'campaign') {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  const actionValues = Array.isArray(row.action_values) ? row.action_values : [];
  const costPerAction = Array.isArray(row.cost_per_action_type) ? row.cost_per_action_type : [];
  const purchaseRoas = Array.isArray(row.purchase_roas) ? row.purchase_roas : [];
  const websitePurchaseRoas = Array.isArray(row.website_purchase_roas) ? row.website_purchase_roas : [];
  const mobileAppPurchaseRoas = Array.isArray(row.mobile_app_purchase_roas) ? row.mobile_app_purchase_roas : [];

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const int = (v) => {
    const n = num(v);
    return n === null ? null : Math.round(n);
  };

  const counts = {};
  const values = {};
  for (const [key, def] of Object.entries(ACTION_GROUPS)) {
    counts[key] = sumByMatcher(actions, def.match);
    values[key] = sumByMatcher(actionValues, def.match);
  }

  const roas = {};
  for (const [key, def] of Object.entries(ROAS_FIELDS)) {
    const src =
      def.source === 'purchase_roas' ? purchaseRoas :
      def.source === 'website_purchase_roas' ? websitePurchaseRoas :
      def.source === 'mobile_app_purchase_roas' ? mobileAppPurchaseRoas : [];
    roas[key] = pickFirstByActionType(src, def.preferred);
  }

  const cpa = {};
  for (const [key, allowed] of Object.entries(COST_PER_ACTION_MAP)) {
    cpa[key] = pickByActionTypes(costPerAction, allowed);
  }

  const entityId =
    level === 'ad' ? (row.ad_id || null) :
    level === 'adset' ? (row.adset_id || null) :
    (row.campaign_id || null);

  return {
    entityId,
    spend: num(row.spend),
    reach: int(row.reach),
    impressions: int(row.impressions),
    cpm: num(row.cpm),
    frequency: num(row.frequency),
    inlineLinkClicks: int(row.inline_link_clicks),
    uniqueInlineLinkClicks: int(row.unique_inline_link_clicks),
    uniqueInlineLinkClickCtr: num(row.unique_inline_link_click_ctr),
    costPerInlineLinkClick: num(row.cost_per_inline_link_click),

    postComments: counts.postComments || 0,
    postEngagements: counts.postEngagements || 0,
    linkClicks: counts.linkClicks || 0,

    landingPageViewsTotal: counts.landingPageViewsTotal || 0,
    landingPageViewsApp: counts.landingPageViewsApp || 0,
    landingPageViewsWebsite: counts.landingPageViewsWebsite || 0,
    costPerLandingPageView: cpa.costPerLandingPageView,

    atcTotal: counts.addToCartTotal || 0,
    atcApp: counts.addToCartApp || 0,
    atcWebsite: counts.addToCartWebsite || 0,
    atcOffline: counts.addToCartOffline || 0,
    atcMeta: counts.addToCartMeta || 0,
    costPerAddToCart: cpa.costPerAddToCart,

    icTotal: counts.initiateCheckoutTotal || 0,
    icApp: counts.initiateCheckoutApp || 0,
    icWebsite: counts.initiateCheckoutWebsite || 0,
    icOffline: counts.initiateCheckoutOffline || 0,
    icMeta: counts.initiateCheckoutMeta || 0,
    costPerInitiateCheckout: cpa.costPerInitiateCheckout,

    purchasesTotal: counts.purchasesTotal || 0,
    purchasesApp: counts.purchasesApp || 0,
    purchasesWebsite: counts.purchasesWebsite || 0,
    purchasesOffline: counts.purchasesOffline || 0,
    purchasesMeta: counts.purchasesMeta || 0,
    costPerPurchase: cpa.costPerPurchase,

    purchaseValueTotal: values.purchasesTotal || 0,
    purchaseValueApp: values.purchasesApp || 0,
    purchaseValueWebsite: values.purchasesWebsite || 0,
    purchaseValueOffline: values.purchasesOffline || 0,
    purchaseValueMeta: values.purchasesMeta || 0,

    purchaseRoasTotal: roas.purchaseRoasTotal,
    purchaseRoasWebsite: roas.purchaseRoasWebsite,
    purchaseRoasApp: roas.purchaseRoasApp,

    rawActionsJson: actions.length ? JSON.stringify(actions) : null,
    rawActionValuesJson: actionValues.length ? JSON.stringify(actionValues) : null,
    rawCostPerActionTypeJson: costPerAction.length ? JSON.stringify(costPerAction) : null,
    rawRoasJson:
      purchaseRoas.length || websitePurchaseRoas.length || mobileAppPurchaseRoas.length
        ? JSON.stringify({ purchaseRoas, websitePurchaseRoas, mobileAppPurchaseRoas })
        : null,
  };
}

export const INSIGHTS_FILTERING_HAD_DELIVERY = JSON.stringify([
  { field: 'campaign.impressions', operator: 'GREATER_THAN', value: 0 },
]);
