import { config } from './env.js';
import { log } from './logger.js';
import { safety } from './safety.js';
import { store } from './store.js';
import { refreshAllLevels } from './refresh.js';
import { discoverPosts, syncPostsComments, analyzeCommentsForPost } from './commentSync.js';
import { analyzerEnabled } from './analyzer.js';
import * as comments from './comments.js';

async function deleteFlaggedComments(runId, postIds, maxDeletes) {
  const moderationOn = safety.isModerationAllowed();
  const candidates = store.getSuggestDeleteComments({ postIds, limit: maxDeletes + 50 });
  let deleted = 0;
  let failed = 0;
  let skipped = 0;

  if (!moderationOn) {
    for (const row of candidates) {
      store.logCmRunAction(runId, {
        action: 'skip_delete',
        commentId: row.id,
        postId: row.post_id,
        campaignName: row.campaign_name,
        category: row.category,
        severity: row.severity,
        messagePreview: row.message,
        success: false,
        errorMessage: 'moderation_disabled',
      });
      skipped += 1;
    }
    return { deleted, failed, skipped, moderationOn };
  }

  for (const row of candidates) {
    if (deleted >= maxDeletes) {
      store.logCmRunAction(runId, {
        action: 'skip_delete',
        commentId: row.id,
        postId: row.post_id,
        campaignName: row.campaign_name,
        category: row.category,
        severity: row.severity,
        messagePreview: row.message,
        success: false,
        errorMessage: 'cap_reached',
      });
      skipped += 1;
      continue;
    }

    try {
      const result = await comments.remove(row.id);
      if (result.blocked) {
        store.logCmRunAction(runId, {
          action: 'delete',
          commentId: row.id,
          postId: row.post_id,
          campaignName: row.campaign_name,
          category: row.category,
          severity: row.severity,
          messagePreview: row.message,
          success: false,
          errorMessage: result.message || 'blocked',
        });
        failed += 1;
        return { deleted, failed, skipped, moderationOn, blocked: true };
      }
      if (!result.ok) {
        store.logCmRunAction(runId, {
          action: 'delete',
          commentId: row.id,
          postId: row.post_id,
          campaignName: row.campaign_name,
          category: row.category,
          severity: row.severity,
          messagePreview: row.message,
          success: false,
          errorMessage: result.error || result.message || 'delete_failed',
        });
        failed += 1;
        continue;
      }
      store.logCmRunAction(runId, {
        action: 'delete',
        commentId: row.id,
        postId: row.post_id,
        campaignName: row.campaign_name,
        category: row.category,
        severity: row.severity,
        messagePreview: row.message,
        success: true,
      });
      deleted += 1;
    } catch (err) {
      store.logCmRunAction(runId, {
        action: 'delete',
        commentId: row.id,
        postId: row.post_id,
        campaignName: row.campaign_name,
        category: row.category,
        severity: row.severity,
        messagePreview: row.message,
        success: false,
        errorMessage: String(err.message || err),
      });
      failed += 1;
    }
  }

  return { deleted, failed, skipped, moderationOn, blocked: false };
}

export async function runCmAuto({ trigger = 'scheduled' } = {}) {
  const startedAt = Date.now();
  const running = store.getRunningCmRun();
  if (running) {
    return {
      ok: false,
      error: 'run_in_progress',
      message: `Another auto-run is already in progress (run #${running.id}, started ${running.started_at}).`,
      runId: running.id,
    };
  }

  if (safety.isKillSwitchActive()) {
    return { ok: false, error: 'kill_switch', message: 'Kill switch is engaged — auto-run refused.' };
  }

  const runId = store.startCmRun(trigger);
  const notes = [];
  let httpCalls = 0;

  try {
    const refresh = await refreshAllLevels({ datePreset: 'last_7d', onlyHadDelivery: false });
    httpCalls += refresh.httpCalls || 0;
    if (!refresh.ok) notes.push(`refresh_failed:${refresh.error || 'unknown'}`);

    const discover = await discoverPosts();
    httpCalls += discover.batchCalls || 0;

    const activePosts = store.getActiveAdPosts();
    const postIds = activePosts.map((p) => p.id);

    const sync = await syncPostsComments(activePosts, {
      analyze: analyzerEnabled(),
      applyRules: true,
      analyzePosts: activePosts,
    });
    httpCalls += sync.batchCalls || 0;
    if (sync.error) notes.push(`sync_failed:${sync.error}`);

    const deleteResult = await deleteFlaggedComments(runId, postIds, config.cmAutoMaxDeletesPerRun);

    const elapsedMs = Date.now() - startedAt;
    const status = notes.length && (deleteResult.deleted === 0 && !sync.comments)
      ? 'partial'
      : (notes.some((n) => n.startsWith('refresh_failed')) ? 'partial' : 'success');

    const summary = {
      activePostIds: postIds,
      activeCampaigns: activePosts.map((p) => p.campaign_name).filter(Boolean),
      refreshOk: !!refresh.ok,
      discoverPosts: discover.processed ?? discover.uniquePosts ?? 0,
      notes,
    };

    const run = store.finishCmRun(runId, {
      status,
      elapsedMs,
      postsActive: activePosts.length,
      postsSynced: sync.postsSynced || activePosts.length,
      commentsFetched: sync.comments || 0,
      commentsAnalyzed: sync.analyzed || 0,
      commentsDeleted: deleteResult.deleted,
      commentsDeleteFailed: deleteResult.failed,
      commentsSkipped: deleteResult.skipped,
      autoHidden: sync.autoHidden || 0,
      httpCalls,
      errorMessage: notes.length ? notes.join('; ') : null,
      summary,
    });

    log.info('cm.auto.done', {
      runId,
      trigger,
      status,
      elapsedMs,
      postsActive: activePosts.length,
      commentsFetched: sync.comments || 0,
      analyzed: sync.analyzed || 0,
      deleted: deleteResult.deleted,
      failed: deleteResult.failed,
      skipped: deleteResult.skipped,
    });

    return {
      ok: true,
      runId,
      run,
      blocked: deleteResult.blocked || false,
      summary: store.getCmSummary(),
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = String(err.message || err);
    log.error('cm.auto.failed', { runId, trigger, error: message, stack: err.stack });
    const run = store.finishCmRun(runId, {
      status: 'error',
      elapsedMs,
      httpCalls,
      errorMessage: message,
      summary: { notes },
    });
    return { ok: false, error: 'auto_run_failed', message, runId, run };
  }
}

export function cmAutoSecretOk(req) {
  const secret = config.cmAutoSecret;
  if (!secret) return false;
  const hdr = (req.headers.authorization || '').toString();
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  const xSecret = (req.headers['x-cm-auto-secret'] || req.query?.secret || req.body?.secret || '').toString().trim();
  return bearer === secret || xSecret === secret;
}
