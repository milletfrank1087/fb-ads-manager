import { randomInt } from 'node:crypto';
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
  {
    id: 'car-t',
    title: 'CAR-T Cell Therapy in Solid vs Hematologic Cancers',
    pillar: 'Cellular Immunotherapy',
    prompt: 'Explain chimeric antigen receptor T-cell therapy: how a patient\'s T-cells are engineered to recognize a tumor antigen. Contrast the established success in B-cell leukemias and lymphomas with the barriers in solid tumors (trafficking, antigen heterogeneity, immunosuppressive microenvironment). Keep it factual and clinical.',
  },
  {
    id: 'stupp-protocol',
    title: 'The Stupp Protocol for Glioblastoma',
    pillar: 'Standard-of-Care Neuro-Oncology',
    prompt: 'Explain the Stupp protocol: maximal safe resection followed by concurrent radiotherapy plus temozolomide, then adjuvant temozolomide. Discuss why MGMT promoter methylation predicts benefit, and why this backbone remains standard even as experimental options are added.',
  },
  {
    id: 'bbb',
    title: 'The Blood-Brain Barrier and Drug Delivery',
    pillar: 'Neuropharmacology',
    prompt: 'Explain the blood-brain barrier as a clinical obstacle in treating brain tumors. Cover tight junctions, efflux pumps, and why many systemic chemotherapies fail to reach therapeutic concentrations in the CNS. Mention focused ultrasound, convection-enhanced delivery, and intra-arterial approaches as investigational delivery methods.',
  },
  {
    id: 'hsct',
    title: 'Hematopoietic Stem Cell Transplant for Pediatric Leukemia',
    pillar: 'Pediatric Hematology',
    prompt: 'Explain allogeneic hematopoietic stem cell transplantation in high-risk pediatric leukemia: conditioning, graft-versus-leukemia, graft-versus-host disease, and the search for a matched related or unrelated donor. Ground it in hospital-ward reality for families, not slogans.',
  },
  {
    id: 'icp-neuro',
    title: 'Raised Intracranial Pressure in Brain Tumors',
    pillar: 'Neurosurgical Emergencies',
    prompt: 'Explain how a brain tumor can raise intracranial pressure: mass effect, edema, hydrocephalus. Cover warning signs clinicians watch for, corticosteroids for vasogenic edema, and when CSF diversion (EVD or shunt) is considered. Keep it educational, not diagnostic advice.',
  },
  {
    id: 'mri-surveillance',
    title: 'MRI Surveillance After Glioma Resection',
    pillar: 'Neuroimaging',
    prompt: 'Explain why serial MRI is used after glioma surgery: distinguishing residual tumor from treatment-related change (pseudoprogression vs true progression). Mention contrast-enhanced sequences, RANO criteria at a high level, and why a single scan rarely settles the question.',
  },
  {
    id: 'infection-prophylaxis',
    title: 'Infection Risk During Intensive Chemotherapy',
    pillar: 'Supportive Oncology',
    prompt: 'Explain why prolonged neutropenia during intensive chemotherapy creates infection risk. Cover central-line care, febrile neutropenia as an emergency, and common prophylaxis strategies (without naming this as medical advice for a specific patient).',
  },
  {
    id: 'fertility-onco',
    title: 'Fertility Preservation Before Gonadotoxic Therapy',
    pillar: 'Oncofertility',
    prompt: 'Explain why gonadotoxic chemotherapy and cranial or pelvic radiotherapy can affect future fertility, and why fertility counseling is time-sensitive before treatment starts. Cover oocyte/embryo cryopreservation and sperm banking at a high level. Keep the tone clinical and respectful.',
  },
  {
    id: 'trial-phases',
    title: 'How Oncology Clinical Trial Phases Actually Work',
    pillar: 'Clinical Research Literacy',
    prompt: 'Explain Phase I vs II vs III oncology trials: safety, dose-finding, activity, and confirmatory endpoints. Clarify randomization, control arms, and why a promising Phase II result is not the same as a new standard of care. No hype.',
  },
  {
    id: 'palliative-intent',
    title: 'Curative vs Palliative Intent in Aggressive Tumors',
    pillar: 'Clinical Ethics & Communication',
    prompt: 'Explain the distinction between curative-intent and palliative-intent treatment in aggressive cancers. Cover how goals-of-care conversations, symptom control, and disease-directed therapy can run in parallel. Dignified, precise language. No sentimentality.',
  },
  {
    id: 'nutrition-chemo',
    title: 'Nutrition and Cachexia During Cancer Treatment',
    pillar: 'Supportive Care',
    prompt: 'Explain cancer cachexia and treatment-related anorexia, mucositis, and taste change. Discuss why maintaining protein-calorie intake matters during intensive therapy, and the role of dietitians and, when indicated, feeding support. Clinical, not wellness-blog tone.',
  },
  {
    id: 'dexamethasone',
    title: 'Corticosteroids for Tumor-Related Brain Edema',
    pillar: 'Neuro-Oncology Supportive Care',
    prompt: 'Explain why dexamethasone is used for vasogenic edema around brain tumors, typical clinical effects (reduced headache, improved alertness), and the trade-offs of prolonged high-dose steroids (hyperglycemia, myopathy, infection risk, mood change). Do not give dosing advice.',
  },
  {
    id: 'mgmt-idh',
    title: 'MGMT, IDH, and Why the Pathology Report Matters',
    pillar: 'Molecular Neuropathology',
    prompt: 'Walk through what MGMT promoter methylation and IDH mutation status mean for a glioma diagnosis and treatment planning. Explain that these are laboratory results used by the treating team, not internet self-diagnosis. Contrast IDH-mutant vs IDH-wildtype disease courses at a high level.',
  },
  {
    id: 'central-lines',
    title: 'Central Venous Lines in Pediatric Oncology',
    pillar: 'Hospital Practice',
    prompt: 'Explain why children on prolonged chemotherapy often have a Broviac, Hickman, or port: blood draws, infusions, reduced needle sticks. Cover line-care burden on parents, occlusion, and infection risk in plain clinical language.',
  },
  {
    id: 'late-effects',
    title: 'Late Effects After Childhood Cancer Treatment',
    pillar: 'Survivorship',
    prompt: 'Explain late effects after pediatric cancer therapy: neurocognitive change after cranial radiation, endocrine deficits, hearing loss after platinum agents, cardiomyopathy after anthracyclines. Frame survivorship clinics as long-term medical follow-up, not inspiration content.',
  },
];

const DRAFT_ANGLES = [
  'Open with a specific hospital-floor or lab-bench detail, then explain the science.',
  'Open with a common misconception patients hear, then correct it with the mechanism.',
  'Open with a timeline (what happens in week 1 vs month 3), then the biology underneath.',
  'Open with a comparison of two approaches and why clinicians choose one setting over the other.',
  'Open with a regulatory or insurance bottleneck, then the clinical reason the delay matters.',
  'Open with a diagnostic test or scan finding, then what the treating team does with that information.',
];

const RECENT_TOPIC_WINDOW = 12;

function recentTopicIds() {
  const fromLogs = store.listPostSchedulerLogs(40)
    .filter((row) => row.status === 'published')
    .flatMap((row) => {
      const ids = [];
      if (row.topic_id) ids.push(row.topic_id);
      const inferred = inferTopicIdFromMessage(row.message);
      if (inferred) ids.push(inferred);
      return ids;
    });

  const fromPage = store.listPagePosts({ limit: 20 })
    .map((p) => inferTopicIdFromMessage(p.message))
    .filter(Boolean);

  return [...fromLogs, ...fromPage].slice(0, RECENT_TOPIC_WINDOW);
}

function inferTopicIdFromMessage(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return null;
  const scored = CLINICAL_TOPICS.map((t) => {
    const needles = t.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4);
    const hits = needles.filter((w) => text.includes(w)).length;
    return { id: t.id, hits };
  }).sort((a, b) => b.hits - a.hits);
  return scored[0]?.hits ? scored[0].id : null;
}

export function pickNextTopic({ excludeIds } = {}) {
  const blocked = new Set(excludeIds || recentTopicIds());
  const unused = CLINICAL_TOPICS.filter((t) => !blocked.has(t.id));
  const pool = unused.length ? unused : CLINICAL_TOPICS;
  return pool[randomInt(pool.length)];
}

const SYSTEM_PROMPT = `You are the lead medical communications and patient advocacy director for RiseHope (https://risehope.online), an international initiative supporting families facing rare pediatric and aggressive oncological diagnoses.

YOUR OBJECTIVE:
Provide rigorous, educational, factual, and dignified content that explains advanced cancer science, clinical trial realities, and patient advocacy.

CRITICAL INVARIANTS:
1. STRICTLY ZERO EMOJIS. Do NOT use any emojis, symbols, or decorative icons anywhere in the output.
2. NO VIBE-CODED BUZZWORDS or marketing clichés (avoid words like "game-changer", "revolutionary", "dawn of a new era", "imagine", "power of", "beacon of hope", "elite army", "superheroes", "warriors").
3. Write in clean, dignified, authoritative English suitable for oncologists, clinical researchers, patients, and serious supporters.
4. Structure with clear, professional paragraphs or brief technical bullet points.
5. Conclude with a dignified statement on patient advocacy and 3-4 professional hashtags (always include #RiseHope).
6. Return ONLY the raw post content ready for publishing. Do NOT wrap in markdown code blocks or add introductory/explanatory commentary.
7. Write ONLY about the assigned topic. If the assigned topic is not dendritic cell therapy, do not mention dendritic cells.
8. Never start with the template "X represents a strategy/specialized form of..." — vary the opening every time.`;

export async function generatePost({ topicId, customPrompt } = {}) {
  if (!config.openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured in environment.');
  }

  let selectedTopic = null;
  if (topicId) {
    selectedTopic = CLINICAL_TOPICS.find((t) => t.id === topicId) || null;
  }
  if (!selectedTopic && !customPrompt) {
    selectedTopic = pickNextTopic();
  }

  const angle = DRAFT_ANGLES[randomInt(DRAFT_ANGLES.length)];
  const promptText = customPrompt || [
    `ASSIGNED TOPIC (mandatory, do not switch): ${selectedTopic.title}`,
    `PILLAR: ${selectedTopic.pillar}`,
    `DRAFT ANGLE: ${angle}`,
    'Do not write about any other clinical topic.',
    selectedTopic.id === 'dc-vaccines'
      ? ''
      : 'Do not mention dendritic cell therapy, DC vaccines, or pulsed autologous dendritic cells.',
    'Do not open with "X represents a strategy" or "X represents a specialized form".',
    '',
    selectedTopic.prompt,
  ].filter(Boolean).join('\n');

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
          temperature: 0.95,
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

  const leakedDc = selectedTopic && selectedTopic.id !== 'dc-vaccines'
    && /dendritic cell/i.test(content);
  if (leakedDc) {
    log.warn('post.generate.topic_leak', { wanted: selectedTopic.id, snippet: content.slice(0, 120) });
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

export async function publishPost({ message, pillar, model, topicId } = {}) {
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('Post message content is required.');
  }

  const pageId = config.targetPageId || '113297813778299';
  const trimmed = message.trim();

  log.info('post.publish.start', { pageId, length: trimmed.length, topicId: topicId || null });

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
      topic_id: topicId || null,
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
    topic_id: topicId || null,
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
  let topic = pickNextTopic();

  try {
    let gen = await generatePost({ topicId: topic.id });
    if (topic.id !== 'dc-vaccines' && /dendritic cell/i.test(gen.content)) {
      log.warn('autopost.cycle.retry_topic_leak', { firstTopic: topic.id });
      topic = pickNextTopic({ excludeIds: [topic.id, 'dc-vaccines', ...recentTopicIds()] });
      gen = await generatePost({ topicId: topic.id });
    }
    const pub = await publishPost({
      message: gen.content,
      pillar: gen.pillar,
      model: gen.model,
      topicId: gen.topicId,
    });
    return { ok: pub.ok, topic: gen.topicTitle, postId: pub.postId, error: pub.error };
  } catch (err) {
    log.error('autopost.cycle.error', { error: err.message, topic: topic.id });
    store.logPostSchedulerAction({
      pillar: topic.pillar,
      status: 'failed',
      error: err.message,
      topic_id: topic.id,
    });
    return { ok: false, error: err.message };
  }
}
