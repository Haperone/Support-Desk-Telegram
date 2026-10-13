const DATA_TABLE = /\b(statistics_report_cache|statistics_facts|statistics_users|manager_statistics_preferences|statistics_schedules|operator_note_drafts|service_checks|operator_input_navigation|operator_ui_sessions|manager_work_navigation|manager_home_screens|conversation_work|operator_work_inputs|bot_message_drafts|service_notification_outbox|manager_work_flows|service_topic_history|user_access_events|conversations|conversation_auto_replies|bot_message_flows|bot_welcome_attempts|message_mappings|pending_messages|media_groups|media_group_items|message_delivery_attempts|conversation_provision_attempts|conversation_reopen_effects|reopen_business_messages|verification_challenges|verification_attempts|user_abuse_state|logical_message_guards|processed_updates|general_message_claims|general_callback_recoveries|reaction_checks|reaction_sync_locks|conversation_locks|abuse_decision_locks|pending_flush_locks|operator_pending_actions)\b/i;

// Locate only top-level SQL keywords. Quoted strings, quoted identifiers and
// nested SELECTs must not change where an invocation's generation predicate goes.
function tokens(sql) {
  const result = []; let depth = 0; let quote = null;
  for (let i = 0; i < sql.length;) {
    const char = sql[i];
    if (quote) {
      if (char === quote) { if (sql[i + 1] === quote) { i += 2; continue; } quote = null; }
      i++; continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; i++; continue; }
    if (char === '[') { const end = sql.indexOf(']', i + 1); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.slice(i, i + 2) === '--') { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.slice(i, i + 2) === '/*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; continue; }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth === 0 && char === ',') result.push({ word: ',', start: i, end: i + 1 });
    if (depth === 0 && /[a-z_]/i.test(char)) {
      const start = i;
      while (i < sql.length && /[a-z_0-9]/i.test(sql[i])) i++;
      result.push({ word: sql.slice(start, i).toUpperCase(), start, end: i }); continue;
    }
    i++;
  }
  return result;
}

export function guardStorageGeneration(sql, generation) {
  if (!DATA_TABLE.test(sql)) return sql;
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid storage generation");
  sql = sql.trim().replace(/;$/, "");
  const words = tokens(sql);
  const gate = `(SELECT generation = ${generation} AND mode = 'normal' FROM storage_control WHERE id = 1)`;
  const first = words[0]?.word;
  if (first === 'SELECT' || first === 'WITH') return `SELECT * FROM (${sql}) WHERE ${gate}`;
  if (first === 'UPDATE' || first === 'DELETE') {
    const boundary = words.find((entry) => ['RETURNING', 'ORDER', 'LIMIT'].includes(entry.word));
    const end = boundary?.start ?? sql.length;
    const where = words.find((entry) => entry.word === 'WHERE' && entry.start < end);
    return where ? `${sql.slice(0, where.end)} (${sql.slice(where.end, end)}) AND ${gate} ${sql.slice(end)}`
      : `${sql.slice(0, end)} WHERE ${gate} ${sql.slice(end)}`;
  }
  if (first === 'INSERT') {
    const values = words.find((entry) => entry.word === 'VALUES' || entry.word === 'SELECT');
    if (!values) throw new Error("Unsupported guarded INSERT");
    const end = words.find((entry, index) => entry.start > values.start && (entry.word === 'RETURNING' || entry.word === 'ON' && words[index + 1]?.word === 'CONFLICT'))?.start ?? sql.length;
    const body = sql.slice(values.end, end).trim();
    if (values.word === 'VALUES') {
      if (!body.startsWith('(') || !body.endsWith(')') || tokens(body).length) throw new Error("Unsupported multiple-row guarded VALUES");
      return `${sql.slice(0, values.start)}SELECT ${body.slice(1, -1)} WHERE ${gate} ${sql.slice(end)}`;
    }
    return `${sql.slice(0, values.start)}SELECT * FROM (${sql.slice(values.start, end)}) WHERE ${gate} ${sql.slice(end)}`;
  }
  throw new Error("Unsupported SQL in storage generation fence");
}
