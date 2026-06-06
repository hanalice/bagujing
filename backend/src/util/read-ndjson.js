import fs from 'node:fs';
import readline from 'node:readline';

// 工具函数：读取 NDJSON 文件
export default async function readNdjson(filePath) {
  try {
    // Use promise-based API; fs.readFile requires a callback
    const content = await fs.promises.readFile(filePath, { encoding: 'utf8' });
    return content
      .trim()
      .split('\n')
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.error('Invalid JSON line, skip:', e.message);
          return null;
        }
      })
      .filter(item => item !== null);
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error.message);
    return [];
  }
}

/**
 * Pull-based NDJSON line reader.
 * - next(): Promise<{ done: boolean, value?: any }>
 * - close(): void
 */
export function createNdjsonLineReader(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let queue = [];
  let ended = false;
  let error = null;
  let pendingResolve = null;

  rl.on('line', (line) => {
    // 拿到一行后立刻暂停，等待显式请求下一行
    rl.pause();
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  });

  rl.once('close', () => {
    ended = true;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(null);
    }
  });

  rl.once('error', (err) => {
    error = err;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(Promise.reject(err));
    }
  });

  function takeLine() {
    if (queue.length) return Promise.resolve(queue.shift());
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      pendingResolve = resolve;
      rl.resume(); // 允许流继续读到下一行（读到后会触发 pause）
    });
  }

  async function next() {
    if (error) throw error;
    const line = await takeLine();
    if (line == null) return { done: true, value: undefined };
    let value;
    try {
      value = String(line).trim() ?? undefined;
    } catch (e) {
      console.warn('Invalid NDJSON line, skip:', e.message);
      value = undefined;
    }
    // 读取器已在 'line' 事件处暂停；这里不主动继续，等下次 next() 再 resume
    return { done: false, value };
  }

  function close() {
    try { rl.close(); } catch {}
    try { stream.destroy(); } catch {}
  }

  return { next, close };
}

