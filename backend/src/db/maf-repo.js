const MAF_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS maf_mission_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT UNIQUE,
    goal TEXT,
    total_tokens INTEGER DEFAULT 0,
    user_chat_rounds INTEGER DEFAULT 0,
    feedback_rounds INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active', -- 'active', 'completed', 'cancelled'
    agent_iterations INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_maf_mission_id ON maf_mission_audits(mission_id);
  CREATE INDEX IF NOT EXISTS idx_maf_status ON maf_mission_audits(status);

  CREATE TABLE IF NOT EXISTS ai_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT,
    client_id TEXT,
    user_identifier TEXT,
    action_type TEXT,
    action_name TEXT,
    page_path TEXT,
    page_title TEXT,
    payload_preview TEXT,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    status_code INTEGER,
    decision TEXT,
    reason TEXT,
    duration_ms INTEGER DEFAULT 0,
    client_ip_hash TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ai_audit_created_at ON ai_audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_audit_client_id ON ai_audit_logs(client_id);
`;

export async function initMafSchema(pool) {
    await pool.withConnection((db) => db.exec(MAF_TABLE_SQL));
}

export async function createMissionAudit(pool, { missionId, goal }) {
    return pool.withConnection(async (db) => {
        const sql = `
      INSERT INTO maf_mission_audits (mission_id, goal)
      VALUES (?, ?)
      ON CONFLICT(mission_id) DO UPDATE SET
        goal = excluded.goal,
        updated_at = datetime('now')
      RETURNING id
    `;
        const result = await db.get(sql, [missionId, goal]);
        return result?.id;
    });
}

export async function updateMissionTokens(pool, missionId, additionalTokens) {
    return pool.withConnection((db) =>
        db.run(
            `UPDATE maf_mission_audits 
       SET total_tokens = total_tokens + ?, updated_at = datetime('now') 
       WHERE mission_id = ?`,
            [Number(additionalTokens), missionId]
        )
    );
}

export async function incrementUserChatRound(pool, missionId) {
    return pool.withConnection((db) =>
        db.run(
            `UPDATE maf_mission_audits 
       SET user_chat_rounds = user_chat_rounds + 1, 
           updated_at = datetime('now') 
       WHERE mission_id = ?`,
            [missionId]
        )
    );
}

export async function incrementFeedbackRound(pool, missionId) {
    return pool.withConnection((db) =>
        db.run(
            `UPDATE maf_mission_audits 
       SET feedback_rounds = feedback_rounds + 1, 
           updated_at = datetime('now') 
       WHERE mission_id = ?`,
            [missionId]
        )
    );
}

export async function finalizeMission(pool, missionId, status = 'completed') {
    return pool.withConnection((db) =>
        db.run(
            `UPDATE maf_mission_audits 
       SET status = ?, updated_at = datetime('now') 
       WHERE mission_id = ?`,
            [status, missionId]
        )
    );
}

export async function getMissionAudit(pool, missionId) {
    return pool.withConnection((db) =>
        db.get(`SELECT * FROM maf_mission_audits WHERE mission_id = ?`, [missionId])
    );
}

export async function listMissionAudits(pool, limit = 50) {
    return pool.withConnection((db) =>
        db.all(`SELECT * FROM maf_mission_audits ORDER BY created_at DESC LIMIT ?`, [limit])
    );
}
