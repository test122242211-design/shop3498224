const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const config = require("./config");

const dir = path.dirname(config.databasePath);
if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });

const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  product TEXT,
  status TEXT NOT NULL,
  invoice_id TEXT,
  proof_json TEXT,
  staff_message_id TEXT,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER,
  decided_at INTEGER,
  decision_by TEXT,
  coupon_code TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(ticket_id) REFERENCES tickets(id)
);
`);

const stmts = {
  createTicket: db.prepare(`INSERT INTO tickets
    (id,guild_id,channel_id,user_id,kind,product,status,created_at)
    VALUES (@id,@guild_id,@channel_id,@user_id,@kind,@product,@status,@created_at)`),
  getTicket: db.prepare("SELECT * FROM tickets WHERE id = ?"),
  getByChannel: db.prepare("SELECT * FROM tickets WHERE channel_id = ?"),
  update: db.prepare(`UPDATE tickets SET
    status=COALESCE(@status,status),
    product=COALESCE(@product,product),
    invoice_id=COALESCE(@invoice_id,invoice_id),
    proof_json=COALESCE(@proof_json,proof_json),
    staff_message_id=COALESCE(@staff_message_id,staff_message_id),
    deadline_at=COALESCE(@deadline_at,deadline_at),
    decided_at=COALESCE(@decided_at,decided_at),
    decision_by=COALESCE(@decision_by,decision_by),
    coupon_code=COALESCE(@coupon_code,coupon_code)
    WHERE id=@id`),
  addMessage: db.prepare("INSERT INTO messages(ticket_id,role,content,created_at) VALUES(?,?,?,?)"),
  history: db.prepare("SELECT role,content FROM messages WHERE ticket_id=? ORDER BY id DESC LIMIT ?"),
  pending: db.prepare("SELECT * FROM tickets WHERE status='awaiting_staff' AND deadline_at IS NOT NULL"),
  allOpen: db.prepare("SELECT * FROM tickets WHERE status NOT IN ('closed','approved','declined','auto_approved')")
};

function updateTicket(x) {
  return stmts.update.run({
    id: x.id,
    status: x.status ?? null,
    product: x.product ?? null,
    invoice_id: x.invoice_id ?? null,
    proof_json: x.proof_json ?? null,
    staff_message_id: x.staff_message_id ?? null,
    deadline_at: x.deadline_at ?? null,
    decided_at: x.decided_at ?? null,
    decision_by: x.decision_by ?? null,
    coupon_code: x.coupon_code ?? null
  });
}

module.exports = {
  db,
  createTicket: (x) => stmts.createTicket.run(x),
  getTicket: (id) => stmts.getTicket.get(id),
  getByChannel: (id) => stmts.getByChannel.get(id),
  updateTicket,
  addMessage: (ticketId, role, content) => stmts.addMessage.run(ticketId, role, content, Date.now()),
  getHistory: (ticketId, limit) => stmts.history.all(ticketId, limit).reverse(),
  getPending: () => stmts.pending.all(),
  getOpenTickets: () => stmts.allOpen.all()
};
