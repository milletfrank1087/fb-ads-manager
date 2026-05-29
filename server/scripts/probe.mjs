import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const TOKEN = process.env.FB_SYSTEM_USER_ACCESS_TOKEN.trim();
const SECRET = process.env.FB_APP_SECRET.trim();
const ACCT = process.env.FB_PRIMARY_ACCOUNT_ID.trim();
const VER = (process.env.GRAPH_API_VERSION || 'v25.0').trim();
const proxyUrl = `http://${encodeURIComponent(process.env.PROXY_USER.trim())}:${encodeURIComponent(process.env.PROXY_PASS.trim())}@${process.env.PROXY_HOST.trim()}:${process.env.PROXY_PORT.trim()}`;

const http = axios.create({
  baseURL: `https://graph.facebook.com/${VER}`,
  timeout: 30000,
  httpsAgent: new HttpsProxyAgent(proxyUrl),
  proxy: false,
  validateStatus: () => true,
});

const proof = crypto.createHmac('sha256', SECRET).update(TOKEN).digest('hex');

async function g(p, params = {}) {
  const r = await http.get(p, { params: { access_token: TOKEN, appsecret_proof: proof, ...params } });
  return { status: r.status, body: r.data };
}

function short(v, n = 1200) {
  const s = JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function main() {
  // 1) Pixels / datasets
  const pix = await g(`${ACCT}/adspixels`, { fields: 'id,name,last_fired_time,is_unavailable' });
  console.log('\n=== 1) PIXELS ===', pix.status);
  console.log(short(pix.body));
  const pixelId = pix.body?.data?.[0]?.id;

  // 2) EMQ / Dataset Quality — try a few endpoint shapes
  if (pixelId) {
    for (const [label, p, params] of [
      ['/{pixel}/dataset_quality', `${pixelId}/dataset_quality`, {}],
      ['/dataset_quality?dataset_id', 'dataset_quality', { dataset_id: pixelId }],
      ['/{pixel}?fields=event_match_quality', `${pixelId}`, { fields: 'id,name,event_match_quality' }],
    ]) {
      const r = await g(p, params);
      console.log(`\n=== 2) EMQ via ${label} ===`, r.status);
      console.log(short(r.body, 900));
    }
  } else {
    console.log('\n=== 2) EMQ === no pixel id found, skipping');
  }

  // 3) DCO — asset_feed_spec on sample ads
  const ads = await g(`${ACCT}/ads`, { fields: 'name,effective_status,creative{id,asset_feed_spec}', limit: 8 });
  console.log('\n=== 3) DCO (asset_feed_spec on ads) ===', ads.status);
  const adRows = ads.body?.data || [];
  console.log('ads sampled:', adRows.length, '| with asset_feed_spec:', adRows.filter((a) => a.creative?.asset_feed_spec).length);
  console.log(short(adRows.map((a) => ({ name: a.name, status: a.effective_status, hasAFS: !!a.creative?.asset_feed_spec })), 1400));

  // 4) Creative ranking diagnostics
  const rank = await g(`${ACCT}/insights`, {
    level: 'ad', date_preset: 'last_30d',
    fields: 'ad_name,impressions,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,frequency',
    limit: 10, sort: 'impressions_descending',
  });
  console.log('\n=== 4) CREATIVE RANKING (ad-level) ===', rank.status);
  console.log(short((rank.body?.data || []).map((r) => ({
    ad: (r.ad_name || '').slice(0, 28), impr: r.impressions, q: r.quality_ranking, e: r.engagement_rate_ranking, c: r.conversion_rate_ranking, f: r.frequency,
  })), 1600));

  // 5) Segment cell volumes (age/gender) — how many purchases per cell?
  const seg = await g(`${ACCT}/insights`, {
    date_preset: 'last_30d', breakdowns: 'age,gender',
    fields: 'spend,impressions,actions', limit: 100,
  });
  console.log('\n=== 5) AGE/GENDER CELL VOLUMES ===', seg.status);
  const cells = (seg.body?.data || []).map((r) => {
    const purch = (r.actions || []).find((a) => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
    return { cell: `${r.age}/${r.gender}`, spend: Number(r.spend || 0).toFixed(0), purch: purch ? Number(purch.value) : 0 };
  });
  console.log('cells:', cells.length);
  console.log(short(cells, 1800));

  // 6) Net New Reach feasibility — account reach over two windows
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const d30 = new Date(today.getTime() - 30 * 864e5);
  const d60 = new Date(today.getTime() - 60 * 864e5);
  const reachThis = await g(`${ACCT}/insights`, { time_range: JSON.stringify({ since: iso(d30), until: iso(today) }), fields: 'reach,frequency,impressions' });
  const reachComb = await g(`${ACCT}/insights`, { time_range: JSON.stringify({ since: iso(d60), until: iso(today) }), fields: 'reach,frequency,impressions' });
  console.log('\n=== 6) NET NEW REACH feasibility ===', reachThis.status, reachComb.status);
  console.log('last30 reach:', short(reachThis.body?.data?.[0]), '| last60 reach:', short(reachComb.body?.data?.[0]));

  // 7) Ad set optimization goal + bid strategy (for cap-graduation logic)
  const as = await g(`${ACCT}/adsets`, { fields: 'name,optimization_goal,billing_event,bid_strategy,daily_budget,effective_status', limit: 12 });
  console.log('\n=== 7) ADSET optimization/bid ===', as.status);
  console.log(short((as.body?.data || []).map((r) => ({
    name: (r.name || '').slice(0, 24), opt: r.optimization_goal, bid: r.bid_strategy, daily: r.daily_budget, st: r.effective_status,
  })), 1800));

  console.log('\n=== PROBE DONE ===');
}

main().catch((e) => { console.error('PROBE ERROR', e?.message || e); process.exit(1); });
