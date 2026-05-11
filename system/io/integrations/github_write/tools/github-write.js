import { checkActionTrust, recordOutcome } from '../../../../cognition/jobs/action-trust.js';
import { checkOutbound } from '../../../../cognition/discretion/outbound-policy.js';
import { checkRateLimit } from '../../../outbound/rate-limit.js';
import { addComment, applyLabels, createIssue, markNotificationRead } from '../client.js';

export function createGitHubWriteTool({ db, capture }) {
  return {
    name: 'github_write',
    description:
      'Write to GitHub: create-issue, comment, label, or mark-read. Text actions pass through outbound-policy.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create-issue', 'comment', 'label', 'mark-read'] },
        args: { type: 'object' },
      },
      required: ['action', 'args'],
    },
    handler: async (input) => {
      const rate = await checkRateLimit(db, 'github_write');
      if (!rate.ok) return rate;
      const { action, args } = input;
      switch (action) {
        case 'create-issue':
        case 'comment':
        case 'label':
        case 'mark-read':
          break;
        default:
          return { ok: false, reason: 'unknown_action', action };
      }
      const cls = `github_write:${action}`;
      const trust = await checkActionTrust(db, 'github_write', action);
      if (trust.state === 'NEVER') {
        return { ok: false, reason: 'action_not_allowed', class: cls };
      }
      if (trust.state === 'ASK' && args?.force !== true) {
        return {
          ok: false,
          reason: 'requires_permission',
          class: cls,
          last_state_change_at: trust.last_state_change_at,
        };
      }
      switch (action) {
        case 'create-issue': {
          const text = `${args.title ?? ''}\n${args.body ?? ''}\n${(args.labels ?? []).join(',')}`;
          const policy = await checkOutbound(db, { destination: 'github_write', text });
          if (!policy.ok)
            return { ok: false, reason: 'outbound_blocked', blocked_by: policy.reason };
          const r = await createIssue(args);
          await capture([
            {
              source: 'github_write',
              content: text,
              external_id: `${args.repo}:${r.number}`,
              meta: {
                action: 'create-issue',
                repo: args.repo,
                number: r.number,
                url: r.html_url,
              },
            },
          ]);
          await recordOutcome(db, cls, 'success');
          return { ok: true, url: r.html_url, id: r.number };
        }
        case 'comment': {
          const text = args.body ?? '';
          const policy = await checkOutbound(db, { destination: 'github_write', text });
          if (!policy.ok)
            return { ok: false, reason: 'outbound_blocked', blocked_by: policy.reason };
          const r = await addComment(args);
          await capture([
            {
              source: 'github_write',
              content: text,
              external_id: `${args.repo}:${args.issue_id}:${r.id}`,
              meta: {
                action: 'comment',
                repo: args.repo,
                issue_id: args.issue_id,
                comment_id: r.id,
                url: r.html_url,
              },
            },
          ]);
          await recordOutcome(db, cls, 'success');
          return { ok: true, url: r.html_url, id: r.id };
        }
        case 'label': {
          const r = await applyLabels(args);
          console.log(
            `[github_write] applied labels on ${args.repo}#${args.issue_id}: +${(r.added ?? []).join(',')} -${(r.removed ?? []).join(',')}`,
          );
          await recordOutcome(db, cls, 'success');
          return { ok: true, ...r };
        }
        case 'mark-read': {
          await markNotificationRead(args);
          console.log(`[github_write] marked notification ${args.notification_id} read`);
          await recordOutcome(db, cls, 'success');
          return { ok: true };
        }
      }
    },
  };
}
