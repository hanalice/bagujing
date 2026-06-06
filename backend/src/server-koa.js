import Koa from 'koa';
import Router from '@koa/router';
import cors from '@koa/cors';
import bodyParser from 'koa-bodyparser';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new Koa();
const router = new Router();
const PORT = 3001; // 为了避免冲突，Koa 使用 3001 端口

// 全局错误兜底 + 请求日志（洋葱模型：await next() 前后分别是 in/out）
app.use(async (ctx, next) => {
  const requestId = ctx.get('x-request-id') || randomUUID();
  ctx.state.requestId = requestId;
  ctx.set('X-Request-Id', requestId);

  const start = Date.now();
  try {
    await next();
  } catch (error) {
    const status = Number(error?.status || error?.statusCode) || 500;
    ctx.status = status;
    ctx.body = {
      code: status,
      message: error?.message || 'Internal Server Error'
    };
    ctx.app.emit('error', error, ctx);
  } finally {
    const ms = Date.now() - start;
    ctx.set('X-Response-Time', `${ms}ms`);
    console.log(`[${requestId}] ${ctx.method} ${ctx.path} -> ${ctx.status} ${ms}ms`);
  }
});

app.on('error', (error, ctx) => {
  const requestId = ctx?.state?.requestId || '-';
  console.error(`[${requestId}]`, error);
});

// 工具函数：读取 NDJSON 文件
async function readNdjson(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(item => item !== null);
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return [];
  }
}

// 路由定义
router.get('/api/problems', async (ctx) => {
  const { keyword, category, page = 1, pageSize = 10 } = ctx.query;
  const problemsPath = path.join(__dirname, '../data/problems.ndjson');

  let problems = await readNdjson(problemsPath);

  // 过滤
  if (keyword) {
    const lowerKeyword = String(keyword).toLowerCase();
    problems = problems.filter(p =>
      (p.title && p.title.toLowerCase().includes(lowerKeyword)) ||
      (p.content && p.content.toLowerCase().includes(lowerKeyword))
    );
  }

  if (category) {
    problems = problems.filter(p => p.category === category);
  }

  // 分页
  const total = problems.length;
  const start = (Number(page) - 1) * Number(pageSize);
  const end = start + Number(pageSize);
  const list = problems.slice(start, end);

  ctx.body = {
    code: 0,
    data: {
      list,
      total,
      page: Number(page),
      pageSize: Number(pageSize)
    },
    message: 'success'
  };
});

// 注册中间件
app.use(cors());
app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());

// 启动服务
app.listen(PORT, () => {
  console.log(`Koa server running at http://localhost:${PORT}`);
});
