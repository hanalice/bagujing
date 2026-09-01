import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import { createAiGuard, readStreamChunkWithTimeout } from './security/ai-guard.js';
import fs from 'node:fs/promises';
import Redis from 'ioredis';
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { buildPromptMessages, promptBudget, PROMPT_BUDGET_ERROR_RESERVED } from './prompt-budget.js';
import { createLlmModel } from './llm.js';

import { createSqlitePool } from './db/sqlite-pool.js';
import { initCategorySchema, listCategories, countCategories, listCategoryGroupNames } from './db/category-repo.js';
import { initProblemSchema, getProblemById, getProblemRawById, listProblems, countProblems, listProblemCompanies, listProblemKeyPoints } from './db/problem-repo.js';
import { initProblemDetailSchema, getProblemDetailById, upsertProblemAnswerById } from './db/problem-detail-repo.js';
import { initMafSchema, createMissionAudit, updateMissionTokens, incrementUserChatRound, incrementFeedbackRound, finalizeMission, getMissionAudit, listMissionAudits } from './db/maf-repo.js';
import {
  initUserSchema,
  registerUser,
  getUserByUsername,
  getUserById,
  listPendingUsers,
  approveUser,
  updateUserPreferences,
  getPermissionsByRole
} from './db/user-repo.js';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Auth System ---
const JWT_SECRET = process.env.JWT_SECRET || 'bagujing-secret-2026';

let sqlitePool;
const aiGuard = createAiGuard({ jwtSecret: JWT_SECRET });
if (process.env.REDIS_URL) {
  aiGuard.redis = new Redis(process.env.REDIS_URL);
}

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

let sqlitePoolPromise;

async function getSqlitePool() {
  const isSqliteEnabled = process.env.ENABLE_SQLITE === 'true';
  if (!isSqliteEnabled) return null;

  if (!sqlitePoolPromise) {
    const filename = process.env.SQLITE_DB
      ? String(process.env.SQLITE_DB)
      : path.join(__dirname, '../db/bagujing.dev.sqlite3');

    const pool = createSqlitePool({ filename, max: 4 });
    sqlitePool = pool;
    aiGuard.dbPool = pool; // Inject pool into guard
    sqlitePoolPromise = (async () => {
      await initCategorySchema(pool);
      await initProblemSchema(pool);
      await initProblemDetailSchema(pool);
      await initMafSchema(pool);
      await initUserSchema(pool);
      return pool;
    })();
  }

  return sqlitePoolPromise;
}

function getLlmModel(guardContext, role) {
  return createLlmModel(guardContext, {
    maxCompletionTokens: aiGuard.config.maxCompletionTokens,
    upstreamTimeoutMs: aiGuard.config.upstreamTimeoutMs,
  }, role);
}

// 中间件
app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || randomUUID();
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  const logOnce = () => {
    const ms = Date.now() - start;
    console.log(`[${requestId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms}ms`);
  };

  res.once('finish', logOnce);
  res.once('close', logOnce);
  next();
});

app.use(cors(aiGuard.corsOptions));
app.use(express.json()); // 解析 JSON body

const authenticateToken = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ code: 401, message: 'Authentication required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      const requestId = res.getHeader('X-Request-Id') || '-';
      console.warn(`[${requestId}] 403: Invalid or expired token`, err.message);
      return res.status(403).json({ code: 403, message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
});

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    const requestId = res.getHeader('X-Request-Id') || '-';
    console.warn(`[${requestId}] 403: Admin access required. User role: ${req.user?.role}`);
    return res.status(403).json({ code: 403, message: 'Admin access required' });
  }
  next();
};

const hashPassword = (password) => {
  return crypto.createHash('sha256').update(password).digest('hex');
};

const requirePermission = (permission) => (req, res, next) => {
  if (!req.user?.permissions?.includes(permission)) {
    const requestId = res.getHeader('X-Request-Id') || '-';
    console.warn(`[${requestId}] 403: Permission '${permission}' required. User permissions: ${JSON.stringify(req.user?.permissions || [])}`);
    return res.status(403).json({ code: 403, message: `Permission '${permission}' required` });
  }
  next();
};

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ code: 400, message: 'Username and password required' });

  const pool = await getSqlitePool();
  try {
    const existing = await getUserByUsername(pool, username);
    if (existing) return res.status(400).json({ code: 400, message: 'Username already exists' });

    await registerUser(pool, { username, passwordHash: hashPassword(password) });
    res.json({ code: 0, message: 'Registration successful. Waiting for admin approval.' });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const pool = await getSqlitePool();

  const user = await getUserByUsername(pool, username);
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ code: 401, message: 'Invalid username or password' });
  }

  if (user.status !== 'active') {
    return res.status(401).json({ code: 401, message: 'Account is pending approval' });
  }

  const permissions = await getPermissionsByRole(pool, user.role_id);
  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role_name,
      permissions: permissions.map(p => p.name),
      clientId: 'web' // Ensure AI Guard recognizes user session
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    code: 0,
    data: {
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role_name,
        preferences: JSON.parse(user.preferences_json || '{}')
      }
    }
  });
}));

app.get('/api/user/profile', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  const pool = await getSqlitePool();
  const user = await getUserById(pool, req.user.id);
  if (!user) return res.status(404).json({ code: 404, message: 'User not found' });

  // Load permissions
  const permissions = await getPermissionsByRole(pool, user.role_id);

  res.json({
    code: 0,
    data: {
      username: user.username,
      role: user.role_name,
      status: user.status,
      permissions: permissions.map(p => p.name),
      preferences: JSON.parse(user.preferences_json || '{}')
    }
  });
}));

app.post('/api/user/preferences', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  const pool = await getSqlitePool();
  await updateUserPreferences(pool, req.user.id, JSON.stringify(req.body));
  res.json({ code: 0, message: 'Preferences updated' });
}));

app.get('/api/admin/pending-users', authenticateToken, requireAdmin, asyncHandler(async (req, res) => {
  const pool = await getSqlitePool();
  const users = await listPendingUsers(pool);
  res.json({ code: 0, data: users });
}));

app.post('/api/admin/approve-user', authenticateToken, requireAdmin, asyncHandler(async (req, res) => {
  const { userId } = req.body;
  const pool = await getSqlitePool();
  await approveUser(pool, userId);
  res.json({ code: 0, message: 'User approved' });
}));

// Auth: Token Exchange
app.post('/api/auth/token', asyncHandler(async (req, res) => {
  return aiGuard.exchangeToken(req, res);
}));

// Metrics: Prometheus Export
app.get('/api/metrics', asyncHandler(async (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(aiGuard.getMetrics());
}));

// MAF Dashboard & API
app.get('/maf-dashboard', asyncHandler(async (req, res) => {
  const projectRoot = path.resolve(__dirname, '../../');
  const targetPath = path.join(projectRoot, '.agents/maf/dashboard/index.html');

  console.log(`[MAF][PID:${process.pid}] Request: /maf-dashboard`);
  try {
    const content = await fs.readFile(targetPath, 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(content);
    console.log(`[MAF][PID:${process.pid}] Dashboard delivered successfully.`);
  } catch (err) {
    console.error(`[MAF][PID:${process.pid}] Error: ${err.message}`);
    res.status(500).send(`Dashboard Access Error: ${err.message} (Path: ${targetPath})`);
  }
}));

app.get('/api/maf/manifest', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  const projectRoot = path.resolve(__dirname, '../../');
  const manifestPath = path.join(projectRoot, '.agents/maf/maf_manifest.json');

  console.log(`[MAF][PID:${process.pid}] Request: /api/maf/manifest`);
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    res.json(JSON.parse(content));
    console.log(`[MAF][PID:${process.pid}] Manifest delivered.`);
  } catch (err) {
    console.error(`[MAF][PID:${process.pid}] Error: ${err.message}`);
    res.status(404).json({ code: 404, message: `Manifest not found`, error: err.message });
  }
}));

// Admin: Audit Logs
app.get('/api/admin/audit-logs', authenticateToken, requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const clientId = req.query.clientId;
  const decision = req.query.decision;

  const pool = await getSqlitePool();
  const data = await pool.withConnection(async (db) => {
    let query = `SELECT * FROM ai_audit_logs WHERE 1=1`;
    const params = [];

    if (clientId) {
      query += ` AND client_id = ?`;
      params.push(clientId);
    }
    if (decision) {
      query += ` AND decision = ?`;
      params.push(decision);
    }

    const totalRow = await db.get(`SELECT COUNT(*) as count FROM (${query})`, params);

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const logs = await db.all(query, params);
    return { logs, total: totalRow.count };
  });

  res.json({ code: 0, data });
}));

// MAF: Mission Tracking
app.get('/api/maf/missions', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  const pool = await getSqlitePool();
  const audits = await listMissionAudits(pool);
  res.json({ code: 0, data: audits });
}));

app.post('/api/maf/missions/start', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  const { missionId, goal } = req.body;
  if (!missionId) return res.status(400).json({ code: 400, message: 'missionId is required' });

  const pool = await getSqlitePool();
  await createMissionAudit(pool, { missionId, goal: goal || 'Untitled Mission' });
  res.json({ code: 0, message: 'Mission started' });
}));

app.post('/api/maf/missions/:id/rounds/user', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const pool = await getSqlitePool();
  await incrementUserChatRound(pool, id);
  res.json({ code: 0, message: 'User round recorded' });
}));

app.post('/api/maf/missions/:id/rounds/feedback', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const pool = await getSqlitePool();
  await incrementFeedbackRound(pool, id);
  res.json({ code: 0, message: 'Feedback round recorded' });
}));

app.post('/api/maf/missions/:id/complete', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const pool = await getSqlitePool();
  await finalizeMission(pool, id, 'completed');
  res.json({ code: 0, message: 'Mission completed' });
}));

// 路由：根据 ID 获取单个题目
app.get('/api/problems/:id', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;

    const pool = await getSqlitePool();
    if (pool) {
      const detail = await getProblemDetailById(pool, id);
      if (detail) return res.json({ code: 0, data: detail, message: 'success' });

      const problem = await getProblemById(pool, id);
      if (problem) return res.json({ code: 0, data: problem, message: 'success' });

      return res.status(404).json({ code: 404, message: 'Problem not found' });
    }
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
}));

// 路由：获取题目列表
app.get('/api/problems', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  try {
    const { keyword, category, company, level, freqRange, keyPoint, cursor, pageSize = 10 } = req.query;

    const pool = await getSqlitePool();
    if (pool) {
      // 上限取多少是业务权衡：数据量小可以 200/500；数据量大或查询重一般 50/100 更稳。你这个项目里数据来自 SQLite/NDJSON，限制在 100 是一个常见的安全默认值
      const size = Math.max(1, Math.min(100, Number(pageSize) || 10));

      const [{ list, nextCursor }, total] = await Promise.all([
        listProblems(pool, { categoryId: category, keyword, company, level, freqRange, keyPoint, limit: size, cursor }),
        countProblems(pool, { categoryId: category, keyword, company, level, freqRange, keyPoint }),
      ]);

      return res.json({
        code: 0,
        data: {
          list,
          total,
          pageSize: size,
          nextCursor,
        },
        message: 'success'
      });
    }
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
}));

app.get('/api/problem-companies', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  try {
    const { category } = req.query;
    const pool = await getSqlitePool();
    if (pool) {
      const list = await listProblemCompanies(pool, { categoryId: category });
      return res.json({
        code: 0,
        data: list,
        message: 'success'
      });
    }
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
}));

app.get('/api/problem-keypoints', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  try {
    const { category } = req.query;
    const pool = await getSqlitePool();
    if (pool) {
      const list = await listProblemKeyPoints(pool, { categoryId: category });
      return res.json({
        code: 0,
        data: list,
        message: 'success'
      });
    }
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
}));

// 路由：获取分类列表
app.get('/api/categories', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  try {
    const { keyword, groupName, cursor, pageSize = 10 } = req.query;

    // Support multi-group filtering with backward compatibility
    const groups = normalizeQueryArray(req.query, ['groupNames', 'groupNames[]', 'groupName']);

    const pool = await getSqlitePool();
    if (pool) {
      const size = Math.max(1, Math.min(100, Number(pageSize) || 10));

      const [{ list, nextCursor }, total] = await Promise.all([
        listCategories(pool, { keyword, groupNames: groups, limit: size, cursor }),
        countCategories(pool, { keyword, groupNames: groups }),
      ]);

      return res.json({
        code: 0,
        data: {
          list,
          total,
          pageSize: size,
          nextCursor,
        },
        message: 'success'
      });
    }
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
}));

app.get('/api/category-groups', authenticateToken, requirePermission('study'), asyncHandler(async (req, res) => {
  try {
    const pool = await getSqlitePool();
    if (pool) {
      const list = await listCategoryGroupNames(pool);
      return res.json({
        code: 0,
        data: list,
        message: 'success'
      });
    }
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
}));

const sendSSE = (res, payload) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const sanitizeUserText = (value, maxLen) => {
  const text = typeof value === 'string' ? value : '';
  return text.replaceAll(String.fromCodePoint(0), '').slice(0, maxLen);
};

const normalizeHtmlParagraphs = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (/<[^>]+>/.test(text)) return text;

  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) return '';

  return lines.map(line => `<p>${line}</p>`).join('');
};

const isNonEmptyText = (value) => typeof value === 'string' && value.trim().length > 0;

const parseJsonSafe = (value, fallback = null) => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const normalizeStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
};

const pickFirstNonEmptyArray = (...values) => {
  for (const value of values) {
    const arr = normalizeStringArray(value);
    if (arr.length > 0) return arr;
  }
  return [];
};

const normalizeQueryArray = (query, keys) => {
  for (const key of keys) {
    const value = query[key];
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string' && value.trim()) {
      return value.includes(',')
        ? value.split(',').map(s => s.trim()).filter(Boolean)
        : [value.trim()];
    }
  }
  return [];
};
const buildRagContext = async ({ message, categoryId, problemId }) => {
  const maxSnippets = 6;
  const snippets = [];
  const pool = await getSqlitePool();

  if (pool) {
    if (categoryId) {
      const category = await pool.withConnection(db =>
        db.get(`SELECT id, name, group_name, group_desc, count FROM categories WHERE id = ?`, [categoryId])
      );
      if (category) {
        snippets.push({
          type: 'category',
          id: category.id,
          name: category.name,
          groupName: category.group_name,
          groupDesc: category.group_desc,
          count: category.count,
        });
      }
    }

    if (problemId) {
      const problem = await pool.withConnection(db =>
        db.get(`SELECT id, brief_name, key_points_json FROM problems WHERE id = ?`, [problemId])
      );
      if (problem) {
        snippets.push({
          type: 'problem',
          id: problem.id,
          brief_name: problem.brief_name,
          keyPoints: parseJsonSafe(problem.key_points_json, []),
        });
      }
    }

    const q = String(message || '').trim();
    if (!problemId && q.length >= 2) {
      const qLower = q.toLowerCase();
      const keywordLike = `%${qLower}%`;

      const matchedCategories = await pool.withConnection(db =>
        db.all(`
          SELECT id, name, group_name, group_desc, count 
          FROM categories 
          WHERE lower(name) LIKE ? OR lower(group_name) LIKE ? OR lower(group_desc) LIKE ?
          LIMIT ?
        `, [keywordLike, keywordLike, keywordLike, maxSnippets])
      );

      for (const c of matchedCategories) {
        if (snippets.length >= maxSnippets) break;
        if (!snippets.some(s => s.type === 'category' && s.id === c.id)) {
          snippets.push({
            type: 'category',
            id: c.id,
            name: c.name,
            groupName: c.group_name,
            groupDesc: c.group_desc,
            count: c.count,
          });
        }
      }

      let problemQuery = `SELECT id, brief_name, key_points_json, category_id FROM problems WHERE lower(brief_name) LIKE ?`;
      const problemParams = [keywordLike];
      if (categoryId) {
        problemQuery += ` AND category_id = ?`;
        problemParams.push(categoryId);
      }
      problemQuery += ` LIMIT ?`;
      problemParams.push(maxSnippets);

      const matchedProblems = await pool.withConnection(db => db.all(problemQuery, problemParams));
      for (const p of matchedProblems) {
        if (snippets.length >= maxSnippets) break;
        if (!snippets.some(s => s.type === 'problem' && s.id === p.id)) {
          snippets.push({
            type: 'problem',
            id: p.id,
            brief_name: p.brief_name,
            keyPoints: parseJsonSafe(p.key_points_json, []),
            category: p.category_id,
          });
        }
      }
    }

    if (snippets.length > 0) return snippets.slice(0, maxSnippets);
  }

  return snippets.slice(0, maxSnippets);
};

app.post('/api/problems/:id/answer/generate', authenticateToken, requirePermission('study'), aiGuard.middleware, asyncHandler(async (req, res) => {
  const guardContext = req.aiGuard;
  let finalized = false;
  let upstreamReached = false;
  let promptTokens;
  const finalizeGuard = (payload) => {
    if (!guardContext || finalized) return;
    finalized = true;
    guardContext.finalize(payload);
  };

  try {
    const { id } = req.params;
    const force = req.body?.force === true || String(req.body?.force).toLowerCase() === 'true';
    const pool = await getSqlitePool();

    if (!pool) {
      finalizeGuard({ status: 'error', reason: 'sqlite_required', upstreamReached: false });
      return res.status(400).json({ code: 400, message: 'SQLite mode is required' });
    }

    const detail = await getProblemDetailById(pool, id);
    const problem = await getProblemById(pool, id);
    if (!problem) {
      finalizeGuard({ status: 'error', reason: 'problem_not_found', upstreamReached: false });
      return res.status(404).json({ code: 404, message: 'Problem not found' });
    }

    const rawRow = await getProblemRawById(pool, id);
    const raw = parseJsonSafe(rawRow?.raw_json, {});
    const years = Array.isArray(raw?.years) ? raw.years : undefined;
    const companies = pickFirstNonEmptyArray(
      detail?.companies,
      problem?.companies,
      raw?.companies,
      raw?.corps,
    );

    if (!force && isNonEmptyText(detail?.answer)) {
      await upsertProblemAnswerById(pool, {
        id,
        categoryId: problem?.categoryId,
        name: detail?.name || problem?.briefName,
        answer: detail?.answer,
        keyPoints: problem?.keyPoints,
        companies,
        years,
      });

      // 业务缓存命中未触达上游：沿用 A4 upstreamReached 判据，不计配额、全额回补预扣
      finalizeGuard({
        status: 'ok',
        reason: 'cached_answer',
        completionText: detail.answer,
        upstreamStatus: null,
        upstreamReached: false,
      });

      return res.json({
        code: 0,
        data: {
          id: Number(id),
          answer: detail.answer,
          cached: true,
        },
        message: 'success',
      });
    }

    const title = (typeof detail?.name === 'string' && detail.name.trim())
      || (typeof problem?.briefName === 'string' && problem.briefName.trim())
      || `题目 #${id}`;

    const model = getLlmModel(guardContext, 'generation');
    if (!model) {
      finalizeGuard({ status: 'error', reason: 'missing_api_key', upstreamReached: false });
      return res.status(400).json({ code: 400, message: 'OPENAI_API_KEY is required' });
    }

    const snippets = await buildRagContext({
      message: `请回答这道面试题：${title}`,
      categoryId: problem?.categoryId,
      problemId: id,
    });

    const systemPrompt =
      '你是资深技术面试官。请直接输出可用于前端展示的 HTML 片段（仅 body 内内容，不要 markdown 代码块）。\n'
      + '要求：\n'
      + '1) 先给简短结论，再给分点说明；\n'
      + '2) 内容准确、可落地，避免空话；\n'
      + '3) 建议使用 <p>/<h3>/<ul>/<li> 标签。';

    const promptMessages = buildPromptMessages({
      systemPrompt,
      questionLabel: '题目：',
      question: title,
      contextLabel: '上下文（可参考）：',
      snippets,
      budget: promptBudget,
    });
    promptTokens = promptMessages.promptTokens;
    if (promptMessages.budgetError === PROMPT_BUDGET_ERROR_RESERVED) {
      finalizeGuard({
        status: 'error',
        reason: 'prompt_budget_reserved_exceeds_max',
        upstreamReached: false,
        promptTokens,
      });
      return res.status(500).json({
        code: 500,
        message: 'Prompt budget maxChars is smaller than system and question reserved length',
      });
    }

    upstreamReached = true;
    const response = await model.invoke([
      new SystemMessage(promptMessages.system),
      new HumanMessage(promptMessages.human),
    ]);

    const answerRaw = response.content;
    const answerHtml = normalizeHtmlParagraphs(answerRaw);

    if (!isNonEmptyText(answerHtml)) {
      finalizeGuard({ status: 'error', reason: 'empty_answer', promptTokens });
      return res.status(502).json({ code: 502, message: 'Empty answer from AI model' });
    }

    await upsertProblemAnswerById(pool, {
      id,
      categoryId: problem?.categoryId,
      name: detail?.name || problem?.briefName,
      answer: answerHtml,
      keyPoints: problem?.keyPoints,
      companies,
      years,
    });

    finalizeGuard({
      status: 'ok',
      reason: 'generated_answer',
      completionText: answerHtml,
      upstreamStatus: 200,
      promptTokens,
    });

    return res.json({
      code: 0,
      data: {
        id: Number(id),
        answer: answerHtml,
        cached: false,
      },
      message: 'success',
    });
  } catch (error) {
    finalizeGuard({ status: 'error', reason: 'server_error', upstreamReached, promptTokens });
    return res.status(500).json({ code: 500, message: error.message });
  }
}));

app.post('/api/chat', authenticateToken, requirePermission('chat_ai'), aiGuard.middleware, asyncHandler(async (req, res) => {
  const guardContext = req.aiGuard;
  let finalized = false;
  let upstreamReached = false;
  let completionText = '';
  let promptTokens;
  const finalizeGuard = (payload) => {
    if (!guardContext || finalized) return;
    finalized = true;
    guardContext.finalize(payload);
  };

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const model = getLlmModel(guardContext, 'chat');
  if (!model) {
    sendSSE(res, { type: 'error', message: 'OPENAI_API_KEY is required' });
    finalizeGuard({ status: 'error', reason: 'missing_api_key', upstreamReached: false });
    return res.end();
  }

  const message = sanitizeUserText(req.body?.message, aiGuard.config.maxInputChars);
  const categoryId = req.body?.context?.categoryId;
  const problemId = req.body?.context?.problemId;

  if (!message.trim()) {
    sendSSE(res, { type: 'error', message: 'Empty message' });
    finalizeGuard({ status: 'error', reason: 'empty_message', upstreamReached: false });
    return res.end();
  }

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const snippets = await buildRagContext({ message, categoryId, problemId });
    sendSSE(res, { type: 'context', snippets });

    const systemPrompt =
      '你是“面试题库”站内资深技术面试官 AI 小助手。请直接输出可用于前端展示的 HTML 片段（仅 body 内内容，不要 markdown 代码块）。\n'
      + '要求：\n'
      + '1) 先给简短结论，再给分点说明，最后给出可操作的下一步建议；\n'
      + '2) 内容准确、可落地，避免空话；\n'
      + '3) 使用 <p>/<h3>/<ul>/<li> 等 HTML 标签进行格式化。';

    const promptMessages = buildPromptMessages({
      systemPrompt,
      questionLabel: '用户问题：',
      question: message,
      contextLabel: '相关背景知识片段（可参考）：',
      instruction: '请结合背景知识，以资深面试官的角度回答用户的问题。',
      snippets,
      budget: promptBudget,
    });
    promptTokens = promptMessages.promptTokens;
    if (promptMessages.budgetError === PROMPT_BUDGET_ERROR_RESERVED) {
      sendSSE(res, { type: 'error', message: 'Prompt budget maxChars is smaller than system and question reserved length' });
      finalizeGuard({
        status: 'error',
        reason: 'prompt_budget_reserved_exceeds_max',
        upstreamReached: false,
        promptTokens,
      });
      return res.end();
    }

    upstreamReached = true;
    const stream = await model.stream([
      new SystemMessage(promptMessages.system),
      new HumanMessage(promptMessages.human),
    ], {
      signal: abortController.signal,
    });

    const sseIdleTimeoutMs = guardContext?.sseIdleTimeoutMs || aiGuard.config.sseIdleTimeoutMs || 20000;
    const reader = typeof stream?.getReader === 'function'
      ? stream.getReader()
      : (stream?.[Symbol.asyncIterator] ? stream[Symbol.asyncIterator]() : stream);

    try {
      while (true) {
        const { done, value } = await readStreamChunkWithTimeout(reader, sseIdleTimeoutMs);
        if (done) break;
        const chunk = value;
        const delta = chunk?.content;
        if (delta) {
          completionText += delta;
          sendSSE(res, { type: 'delta', text: delta });
        }
      }
    } finally {
      if (typeof reader?.releaseLock === 'function') {
        try { reader.releaseLock(); } catch (_) { }
      }
    }

    finalizeGuard({
      status: 'ok',
      reason: 'stream_done',
      completionText,
      promptTokens,
    });
    sendSSE(res, { type: 'done' });
    return res.end();
  } catch (error) {
    const isTimeout = error?.message === 'SSE idle timeout';
    const isAborted = abortController.signal.aborted;
    finalizeGuard({
      status: 'error',
      reason: (isAborted || isTimeout) ? 'aborted_or_timeout' : 'server_error',
      completionText,
      upstreamReached,
      promptTokens,
    });
    const errorMsg = isTimeout ? 'Stream idle timeout' : (error?.message || String(error));
    if (!res.writableEnded) {
      sendSSE(res, { type: 'error', message: errorMsg });
      return res.end();
    }
  }
}));

// 全局错误兜底（放在所有路由之后）
app.use((error, req, res, next) => {
  const requestId = res.getHeader('X-Request-Id') || '-';
  console.error(`[${requestId}]`, error);

  if (res.headersSent) return next(error);

  const status = Number(error?.status || error?.statusCode) || 500;
  return res.status(status).json({
    code: status,
    message: error?.message || 'Internal Server Error'
  });
});

export { app, buildPromptMessages, promptBudget };

// 启动服务（单测通过 BAGUJING_SKIP_LISTEN=1 跳过 listen，便于离线挂载 /api/chat）
if (process.env.BAGUJING_SKIP_LISTEN !== '1') {
  app.listen(PORT, async () => {
    console.log(`[BOOT][PID:${process.pid}] Express server running at http://localhost:${PORT}`);
    try {
      await getSqlitePool();
      console.log(`[BOOT][PID:${process.pid}] Database pool initialized successfully.`);
      // 通知 PM2 服务已就绪，从而完成 zero-downtime 启动
      if (process.send) {
        process.send('ready');
      }
    } catch (err) {
      console.error(`[BOOT][PID:${process.pid}] Failed to initialize database pool:`, err.message);
    }
  });
}
