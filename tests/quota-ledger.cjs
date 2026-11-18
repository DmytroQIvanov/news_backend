// In-memory PostgreSQL protocol fixture: serializes advisory locks, no sockets or real DB.
const { Pool } = require('pg');
exports.installQuotaLedger = function () {
  const connect = Pool.prototype.connect;
  const query = Pool.prototype.query;
  const rows = new Map();
  const locks = [];
  let tail = Promise.resolve();
  const key = (day, model, purpose) => `${day}:${model}:${purpose}`;
  Pool.prototype.connect = async function () {
    let unlock;
    return {
      release() { unlock?.(); unlock = undefined; },
      async query(sql, args = []) {
        if (sql.includes('pg_advisory_xact_lock')) {
          const previous = tail;
          tail = new Promise((r) => { unlock = r; });
          await previous;
          locks.push(args[0]);
        } else if (sql.startsWith('SELECT purpose')) {
          return { rows: [...rows.values()].filter((r) => r.day === args[0] && r.model === args[1]) };
        } else if (sql.includes('INSERT INTO llm_budget_days')) {
          const [day, model, purpose] = args;
          const k = key(day, model, purpose);
          rows.set(k, { day, model, purpose, used: (rows.get(k)?.used ?? 0) + Number(args[3] ?? 1), input_tokens: 0, output_tokens: 0 });
        }
        if (/^(COMMIT|ROLLBACK)$/.test(sql)) { unlock?.(); unlock = undefined; }
        return { rows: [] };
      },
    };
  };
  Pool.prototype.query = async function (sql, args) {
    if (sql.startsWith('SELECT model')) return { rows: [...rows.values()].filter((r) => r.day === args[0]) };
    return { rows: [] };
  };
  return { rows, locks, restore() { Pool.prototype.connect = connect; Pool.prototype.query = query; } };
};
