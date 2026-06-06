const USER_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'active'
    preferences_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(role_id) REFERENCES roles(id)
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER,
    permission_id INTEGER,
    PRIMARY KEY(role_id, permission_id),
    FOREIGN KEY(role_id) REFERENCES roles(id),
    FOREIGN KEY(permission_id) REFERENCES permissions(id)
  );
`;

export async function initUserSchema(pool) {
  await pool.withConnection(async (db) => {
    await db.exec(USER_TABLE_SQL);
    
    // Seed roles
    await db.run("INSERT OR IGNORE INTO roles (id, name) VALUES (1, 'admin'), (2, 'user')");
    
    // Seed permissions
    await db.run("INSERT OR IGNORE INTO permissions (id, name) VALUES (1, 'chat_ai'), (2, 'study')");
    
    // Admin gets all permissions
    await db.run("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (1, 1), (1, 2)");
    // User gets study by default
    await db.run("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (2, 2)");
  });
}

export async function registerUser(pool, { username, passwordHash }) {
  return pool.withConnection(async (db) => {
    const result = await db.run(
      `INSERT INTO users (username, password_hash, role_id, status) VALUES (?, ?, 2, 'pending')`,
      [username, passwordHash]
    );
    return result.lastID;
  });
}

export async function getUserByUsername(pool, username) {
  return pool.withConnection(async (db) => {
    return db.get(
      `SELECT u.*, r.name as role_name 
       FROM users u 
       JOIN roles r ON u.role_id = r.id 
       WHERE u.username = ?`,
      [username]
    );
  });
}

export async function getUserById(pool, id) {
  return pool.withConnection(async (db) => {
    return db.get(
      `SELECT u.*, r.name as role_name 
       FROM users u 
       JOIN roles r ON u.role_id = r.id 
       WHERE u.id = ?`,
      [id]
    );
  });
}

export async function listPendingUsers(pool) {
  return pool.withConnection(async (db) => {
    return db.all(`SELECT id, username, created_at FROM users WHERE status = 'pending'`);
  });
}

export async function approveUser(pool, userId) {
  return pool.withConnection(async (db) => {
    return db.run(`UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?`, [userId]);
  });
}

export async function updateUserPreferences(pool, userId, preferencesJson) {
  return pool.withConnection(async (db) => {
    return db.run(`UPDATE users SET preferences_json = ?, updated_at = datetime('now') WHERE id = ?`, [preferencesJson, userId]);
  });
}

export async function getPermissionsByRole(pool, roleId) {
  return pool.withConnection(async (db) => {
    return db.all(
      `SELECT p.name 
       FROM permissions p 
       JOIN role_permissions rp ON p.id = rp.permission_id 
       WHERE rp.role_id = ?`,
      [roleId]
    );
  });
}
