const ISSUE_TYPES = [
  'installation',
  'installation_reschedule',
  'installation_followup',
  'reinstallation',
  'damaged',
  'delivery_damage',
  'defective',
  'missing_parts',
  'wrong_part',
  'quality_issue',
  'replacement',
  'return',
  'general',
  'escalation',
];

const ISSUE_ALIASES = {
  install: 'installation',
  installation_request: 'installation',
  reschedule: 'installation_reschedule',
  rescheduling: 'installation_reschedule',
  installation_follow_up: 'installation_followup',
  follow_up: 'installation_followup',
  re_installation: 'reinstallation',
  reinstall: 'reinstallation',
  quality: 'quality_issue',
  product_quality: 'quality_issue',
  damage: 'damaged',
  broken: 'damaged',
  transit_damage: 'delivery_damage',
  damaged_in_delivery: 'delivery_damage',
  defect: 'defective',
  missing: 'missing_parts',
  missing_part: 'missing_parts',
  part_missing: 'missing_parts',
  wrong_component: 'wrong_part',
  replace: 'replacement',
  refund: 'return',
  general_query: 'general',
  query: 'general',
  human: 'escalation',
};

function normalizePhone(input) {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits[1])) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits[2])) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

function lastTenDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function normalizeIssueType(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const resolved = ISSUE_ALIASES[key] || key;
  return ISSUE_TYPES.includes(resolved) ? resolved : null;
}

module.exports = { ISSUE_TYPES, normalizePhone, lastTenDigits, normalizeIssueType };
