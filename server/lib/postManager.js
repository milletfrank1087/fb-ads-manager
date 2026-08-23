import { config } from './env.js';
import { log } from './logger.js';
import { fb } from './fbClient.js';
import { store } from './store.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const CLINICAL_TOPICS = [
  {
    id: 'dc-vaccines',
    title: 'Dendritic Cell Therapy & Cellular Vaccines',
    pillar: 'Cellular Immunotherapy',
    prompt: 'Explain the scientific mechanism of personalized dendritic cell therapy in solid tumors and glioblastoma. Focus on how autologous dendritic cells are pulsed with tumor antigens to train cytotoxic T-lymphocytes against residual microscopic disease post-resection.',
  },
  {
    id: 'insurance-gap',
    title: '5-to-10 Year Clinical Approval & Insurance Gap',
    pillar: 'Healthcare Economics & Advocacy',
    prompt: 'Explain the systemic delay between Phase II/III clinical trial success and standard public/private insurance reimbursement for innovative oncology therapies. Discuss why patient advocacy and community support are necessary to bridge this multi-year timeline for patients with rapidly progressive disease.',
  },
  {
    id: 'biomarkers-ngs',
    title: 'Molecular Biomarkers & Next-Generation Sequencing',
    pillar: 'Precision Oncology',
    prompt: 'Explain the clinical significance of molecular tumor profiling, specifically MGMT promoter methylation, IDH1/2 mutations, and BRAF alterations. Explain how identifying these specific molecular drivers enables oncologists to select targeted therapies rather than non-specific systemic chemotherapy.',
  },
  {
    id: 'proton-therapy',
    title: 'Proton Beam Radiation & Bragg Peak Precision',
    pillar: 'Advanced Radiation Oncology',
    prompt: 'Explain the physics and clinical advantages of Proton Beam Therapy over conventional photon radiation in pediatric brain and spinal tumors. Focus on the Bragg peak phenomenon, explaining how energy is deposited precisely at the tumor site without an exit dose, thereby sparing adjacent developing brain tissue.',
  },
  {
    id: 'caregiver-support',
    title: 'Caregiver Demands & Hospital Ward Reality',
    pillar: 'Patient & Family Support',
    prompt: 'Write an empathetic, grounded tribute to oncology caregivers and parents navigating inpatient pediatric units. Discuss the logistical, psychological, and physical demands of managing complex medication protocols, central lines, and extended hospital stays.',
  },
  {
    id: 'ttfields',
    title: 'Tumor-Treating Fields (TTFields) Biophysics',
    pillar: 'Biophysical Therapies',
    prompt: 'Explain the biophysical mechanism of Tumor-Treating Fields (TTFields) in high-grade gliomas. Detail how low-intensity, intermediate-frequency alternating electric fields disrupt dipole alignment of tubulin and septin during mitotic cell division, leading to apoptosis in rapidly dividing cancer cells.',
  },
  {
    id: 'liquid-biopsy',
    title: 'Liquid Biopsies & ctDNA Monitoring',
    pillar: 'Diagnostic Innovation',
    prompt: 'Explain how liquid biopsies and circulating tumor DNA (ctDNA) analysis are changing disease monitoring in oncology. Explain how routine blood draws can detect minimal residual disease and identify emergent resistance mutations earlier than conventional imaging alone.',
  },
  {
    id: 'neoantigens',
    title: 'Personalized Neoantigen Peptide Vaccines',
    pillar: 'Precision Immunotherapy',
    prompt: 'Explain the process of creating personalized neoantigen peptide vaccines using whole-exome sequencing and RNA sequencing of a resected tumor. Detail how bioinformatics pipelines identify patient-specific somatic mutations to synthesize individualized immunogenic peptides.',
  },
  {
    id: 'second-opinions',
    title: 'Second Opinions & Molecular Pathology Reviews',
    pillar: 'Clinical Best Practices',
    prompt: 'Discuss the clinical necessity of obtaining second opinions and centralized molecular pathology reviews when dealing with rare, atypical, or refractory tumors. Address how diagnostic discordance rates in neuropathology emphasize the value of subspecialized expert review.',
  },
  {
    id: 'cross-border',
    title: 'Cross-Border Medical Access & Clinical Trials',
    pillar: 'Global Patient Advocacy',
    prompt: 'Address the logistical and administrative complexities faced by families seeking specialized clinical trials or advanced immunotherapies in foreign medical centers. Explain how patient advocacy groups assist with medical record translation, institutional coordination, and cross-border access pathways.',
  },
];

const SYSTEM_PROMPT = `You are the lead medical communications and patient advocacy director for RiseHope (https://risehope.online), an international initiative supporting families facing rare pediatric and aggressive oncological diagnoses.

YOUR OBJECTIVE:
Provide rigorous, educational, factual, and dignified content that explains advanced cancer science, clinical trial realities, and patient advocacy.

CRITICAL INVARIANTS:
1. STRICTLY ZERO EMOJIS. Do NOT use any emojis, symbols, or decorative icons anywhere in the output.
2. NO VIBE-CODED BUZZWORDS or marketing clichés (avoid words like "game-changer", "revolutionary", "dawn of a new era", "imagine", "power of", "beacon of hope", "elite army", "superheroes", "warriors").
3. Write in clean, dignified, authoritative English suitable for oncologists, clinical researchers, patients, and serious supporters.
4. Structure with clear, professional paragraphs or brief technical bullet points.
5. Conclude with a dignified statement on patient advocacy and 3-4 professional hashtags (always include #RiseHope).
6. Return ONLY the raw post content ready for publishing. Do NOT wrap in markdown code blocks or add introductory/explanatory commentary.`;

export async function generatePost({ topicId, customPrompt } = {}) {
  if (!config.openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured in environment.');
  }

  let selectedTopic = null;
  if (topicId) {
    selectedTopic = CLINICAL_TOPICS.find((t) => t.id === topicId);
  }

  const promptText = customPrompt || selectedTopic?.prompt || CLINICAL_TOPICS[0].prompt;
  const pillar = selectedTopic?.pillar || 'Medical Oncology & Advocacy';

  const models = [
    config.openrouterModel || 'google/gemini-2.5-flash-lite',
    config.openrouterFallbackModel || 'google/gemini-3.5-flash-lite',
  ];

  let content = null;
  let usedModel = null;
  let lastError = null;

  for (const model of models) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openrouterApiKey}`,
          'HTTP-Referer': 'https://risehope.online',
          'X-Title': 'RiseHope Facebook Posts Manager',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: promptText },
          ],
          temperature: 0.65,
          max_tokens: 750,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        lastError = `OpenRouter ${res.status}: ${errBody}`;
        continue;
      }

      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content?.trim();
      if (raw) {
        content = raw.replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '').trim();
        usedModel = model;
        break;
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  if (!content) {
    throw new Error(`Failed to generate post: ${lastError || 'Unknown OpenRouter error'}`);
  }

  return {
    content,
    model: usedModel,
    pillar,
    topicId: selectedTopic?.id || 'custom',
    topicTitle: selectedTopic?.title || 'Custom Clinical Topic',
  };
}

export async function listPosts({ limit = 30 } = {}) {
  const pageId = config.targetPageId || '113297813778299';
  const fields = 'id,message,created_time,permalink_url,is_published,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)';

  const res = await fb.get(
    `${pageId}/published_posts`,
    { fields, limit: Math.min(100, Math.max(1, limit)) },
    'GET:/page/published_posts',
    { tokenKind: 'page' }
  );

  if (res.ok && res.body?.data) {
    for (const p of res.body.data) {
      store.upsertPagePost({
        id: p.id,
        page_id: pageId,
        message: p.message || '',
        created_time: p.created_time,
        permalink_url: p.permalink_url,
        reactions_count: p.reactions?.summary?.total_count || 0,
        comments_count: p.comments?.summary?.total_count || 0,
        shares_count: p.shares?.count || 0,
        is_published: p.is_published !== false,
      });
    }
  }

  const cached = store.listPagePosts({ pageId, limit });
  return {
    ok: true,
    pageId,
    posts: cached,
    liveSyncOk: res.ok,
    liveError: res.ok ? null : (res.error?.message || res.message),
  };
}

export async function publishPost({ message, pillar, model } = {}) {
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('Post message content is required.');
  }

  const pageId = config.targetPageId || '113297813778299';
  const trimmed = message.trim();

  log.info('post.publish.start', { pageId, length: trimmed.length });

  const res = await fb.pagePost(
    `${pageId}/feed`,
    { message: trimmed, published: 'true' },
    'POST:/page/feed'
  );

  if (!res.ok) {
    const errMsg = res.error?.message || res.message || 'Failed to publish post to Facebook Page.';
    log.error('post.publish.failed', { error: errMsg, status: res.httpStatus });
    store.logPostSchedulerAction({
      pillar,
      model,
      message: trimmed,
      status: 'failed',
      error: errMsg,
    });
    return { ok: false, error: errMsg, status: res.httpStatus };
  }

  const postId = res.body?.id;
  log.info('post.publish.ok', { postId, pageId });

  store.upsertPagePost({
    id: postId,
    page_id: pageId,
    message: trimmed,
    created_time: new Date().toISOString(),
    permalink_url: `https://www.facebook.com/${postId}`,
    is_published: true,
    created_by_app: true,
    pillar: pillar || 'Manual / API',
    model: model || 'google/gemini-2.5-flash-lite',
  });

  store.logPostSchedulerAction({
    pillar,
    model,
    message: trimmed,
    fb_post_id: postId,
    status: 'published',
  });

  return { ok: true, postId, permalinkUrl: `https://www.facebook.com/${postId}` };
}

export async function deletePost(postId) {
  if (!postId) throw new Error('postId is required');

  log.info('post.delete.start', { postId });
  const res = await fb.pageDelete(postId, {}, `DELETE:/post/${postId}`);

  if (!res.ok) {
    const errMsg = res.error?.message || res.message || 'Failed to delete post on Facebook.';
    log.error('post.delete.failed', { postId, error: errMsg });
    return { ok: false, error: errMsg };
  }

  store.deletePagePost(postId);
  log.info('post.delete.ok', { postId });
  return { ok: true, deleted: true, postId };
}

export async function runAutoPostCycle() {
  log.info('autopost.cycle.start');
  const logs = store.listPostSchedulerLogs(10);
  const nextIdx = logs.length % CLINICAL_TOPICS.length;
  const topic = CLINICAL_TOPICS[nextIdx];

  try {
    const gen = await generatePost({ topicId: topic.id });
    const pub = await publishPost({
      message: gen.content,
      pillar: gen.pillar,
      model: gen.model,
    });
    return { ok: pub.ok, topic: topic.title, postId: pub.postId, error: pub.error };
  } catch (err) {
    log.error('autopost.cycle.error', { error: err.message });
    store.logPostSchedulerAction({
      pillar: topic.pillar,
      status: 'failed',
      error: err.message,
    });
    return { ok: false, error: err.message };
  }
}
