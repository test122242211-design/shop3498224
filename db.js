const { Pool } = require("pg");
const config = require("./config");

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is required. Create a free Neon PostgreSQL database and set DATABASE_URL in Render.");
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const ready = pool.query(`
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL, kind TEXT NOT NULL, product TEXT, status TEXT NOT NULL,
    invoice_id TEXT, proof_json TEXT, staff_message_id TEXT, created_at BIGINT NOT NULL,
    deadline_at BIGINT, decided_at BIGINT, decision_by TEXT, coupon_code TEXT,
    ai_muted BOOLEAN NOT NULL DEFAULT FALSE
  );
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_muted BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id),
    role TEXT NOT NULL, content TEXT NOT NULL, created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_ticket_id_id_idx ON messages(ticket_id, id);
  CREATE INDEX IF NOT EXISTS tickets_pending_idx ON tickets(status, deadline_at);
  CREATE TABLE IF NOT EXISTS replacement_blacklist (
    user_id TEXT PRIMARY KEY, reason TEXT, added_by TEXT NOT NULL, created_at BIGINT NOT NULL
  );
`).catch(err => { console.error("PostgreSQL initialization failed:", err); throw err; });

async function query(sql, values = []) {
  await ready;
  return pool.query(sql, values);
}
async function updateTicket(x) {
  return query(`UPDATE tickets SET status=COALESCE($2,status), product=COALESCE($3,product),
    invoice_id=COALESCE($4,invoice_id), proof_json=COALESCE($5,proof_json),
    staff_message_id=COALESCE($6,staff_message_id), deadline_at=COALESCE($7,deadline_at),
    decided_at=COALESCE($8,decided_at), decision_by=COALESCE($9,decision_by),
    coupon_code=COALESCE($10,coupon_code), ai_muted=COALESCE($11,ai_muted) WHERE id=$1`,
  [x.id,x.status??null,x.product??null,x.invoice_id??null,x.proof_json??null,
   x.staff_message_id??null,x.deadline_at??null,x.decided_at??null,x.decision_by??null,x.coupon_code??null,x.ai_muted??null]);
}
module.exports = {
  ready,
  createTicket: async x => query(`INSERT INTO tickets
    (id,guild_id,channel_id,user_id,kind,product,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [x.id,x.guild_id,x.channel_id,x.user_id,x.kind,x.product,x.status,x.created_at]),
  getTicket: async id => (await query("SELECT * FROM tickets WHERE id=$1",[id])).rows[0],
  getByChannel: async id => (await query("SELECT * FROM tickets WHERE channel_id=$1",[id])).rows[0],
  updateTicket,
  addMessage: async (ticketId,role,content) => query(
    "INSERT INTO messages(ticket_id,role,content,created_at) VALUES($1,$2,$3,$4)",[ticketId,role,content,Date.now()]),
  getHistory: async (ticketId,limit) => (await query(
    "SELECT role,content FROM (SELECT id,role,content FROM messages WHERE ticket_id=$1 ORDER BY id DESC LIMIT $2) recent ORDER BY id ASC",
    [ticketId,limit])).rows,
  getPending: async () => (await query("SELECT * FROM tickets WHERE status='awaiting_staff' AND deadline_at IS NOT NULL")).rows,
  hasOpenNetflixReplacement: async userId => (await query(
    `SELECT EXISTS (
      SELECT 1 FROM tickets
      WHERE user_id=$1 AND kind='replacement'
        AND status NOT IN ('closed','approved','declined','auto_approved','blacklisted')
        AND (product='netflix' OR (product IS NULL AND status='choose_product'))
    ) AS found`, [userId])).rows[0].found,
  getBlacklist: async userId => (await query(
    "SELECT user_id,reason,added_by,created_at FROM replacement_blacklist WHERE user_id=$1", [userId])).rows[0],
  addBlacklist: async (userId,reason,addedBy) => query(
    `INSERT INTO replacement_blacklist(user_id,reason,added_by,created_at)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(user_id) DO UPDATE SET reason=EXCLUDED.reason, added_by=EXCLUDED.added_by, created_at=EXCLUDED.created_at`,
    [userId,reason,addedBy,Date.now()]),
  removeBlacklist: async userId => query(
    "DELETE FROM replacement_blacklist WHERE user_id=$1", [userId]),
  getOpenTickets: async () => (await query(
    "SELECT * FROM tickets WHERE status NOT IN ('closed','approved','declined','auto_approved')")).rows
};
