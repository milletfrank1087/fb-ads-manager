import { store } from './store.js';
import { log } from './logger.js';

const VALID_MATCH_TYPES = new Set(['contains', 'regex', 'has_url', 'equals']);

function compileRegex(pattern, caseSensitive) {
  return new RegExp(pattern, caseSensitive ? '' : 'i');
}

function matches(rule, comment) {
  const msg = comment.message || '';
  switch (rule.match_type) {
    case 'has_url':
      return comment.has_url === 1 || /\bhttps?:\/\//i.test(msg);
    case 'contains':
      return rule.case_sensitive
        ? msg.includes(rule.pattern)
        : msg.toLowerCase().includes(rule.pattern.toLowerCase());
    case 'equals':
      return rule.case_sensitive
        ? msg.trim() === rule.pattern
        : msg.trim().toLowerCase() === rule.pattern.toLowerCase();
    case 'regex':
      try { return compileRegex(rule.pattern, rule.case_sensitive).test(msg); } catch { return false; }
    default:
      return false;
  }
}

export const autoMod = {
  list(opts) {
    return store.listRules(opts);
  },

  create({ name, pattern, match_type, case_sensitive = false, is_enabled = true }) {
    if (!name || !pattern) throw new Error('Rule name and pattern are required');
    if (!VALID_MATCH_TYPES.has(match_type)) throw new Error(`match_type must be one of ${[...VALID_MATCH_TYPES].join(', ')}`);
    if (match_type === 'regex') compileRegex(pattern, case_sensitive); // validates
    const id = store.createRule({ name, pattern, match_type, case_sensitive: case_sensitive ? 1 : 0, is_enabled: is_enabled ? 1 : 0 });
    log.info('automod.rule.created', { id, name, match_type });
    return id;
  },

  update(id, fields) {
    if (fields.match_type && !VALID_MATCH_TYPES.has(fields.match_type)) throw new Error('invalid match_type');
    if (fields.match_type === 'regex' && fields.pattern) compileRegex(fields.pattern, fields.case_sensitive);
    const changes = store.updateRule(id, fields);
    log.info('automod.rule.updated', { id, fields });
    return changes;
  },

  remove(id) {
    const changes = store.deleteRule(id);
    log.info('automod.rule.deleted', { id });
    return changes;
  },

  /**
   * Evaluate enabled rules against a set of (visible, non-deleted) comments.
   * Returns [{ comment, rule }] for the FIRST matching rule per comment.
   */
  evaluate(comments) {
    const rules = store.listRules({ enabledOnly: true });
    if (!rules.length) return [];
    const out = [];
    for (const c of comments) {
      if (c.is_hidden) continue;
      for (const rule of rules) {
        if (matches(rule, c)) { out.push({ comment: c, rule }); break; }
      }
    }
    return out;
  },
};
