/**
 * Canonical GitHub label set. Single source so the worker, the seed script,
 * and the client-template workflow file all agree.
 */

export const LABELS = {
  CLIENT_REQUEST: 'client-request',
  NEEDS_TRIAGE: 'needs-triage',
  NEEDS_CLARIFICATION: 'needs-clarification',
  APPROVE_FOR_CLAUDE: 'approve-for-claude',
  APPROVE_FOR_CODEX: 'approve-for-codex',
  AGENT_RUNNING: 'agent-running',
  PR_OPENED: 'pr-opened',
  BLOCKED: 'blocked',
  DONE: 'done',
  REJECTED: 'rejected',
} as const;

export const ALL_LABELS: readonly string[] = Object.values(LABELS);
