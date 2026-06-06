const a = {
  "id":85699,
  "name":"<p>请介绍CPU缓存</p>",
  "options":null,
  "answer":"<p>CPU缓存是位于CPU与内存之间的高速小容量存储器，它的出现是为了解决CPU运算速度与内存读写速度不匹配的问题，以下从多个方面对其进行介绍：</p>\n<h3>工作原理</h3>\n<p>CPU缓存基于局部性原理工作，局部性原理包括时间局部性和空间局部性。时间局部性指的是如果一个数据被访问，那么在近期它很可能会被再次访问；空间局部性指的是如果一个数据被访问，那么与它相邻的数据在近期也可能被访问。当CPU需要访问数据时，首先会在缓存中查找，如果找到（命中），则直接从缓存中读取数据，大大提高了数据读取速度；如果未找到（未命中），则需要从内存中读取数据，并将该数据及其相邻的数据块一起存入缓存，以便后续可能的再次访问。</p>\n<h3>层级结构</h3>\n<p>现代CPU通常采用多级缓存结构，一般分为L1、L2和L3三级缓存：</p>\n<ul>\n  <li><strong>L1缓存</strong>：也称为一级缓存，是CPU第一层高速缓存，分为数据缓存（L1 - D）和指令缓存（L1 - I），分别用于存储数据和指令。L1缓存的容量相对较小，一般在几十KB到几百KB之间，但速度极快，与CPU的核心运算速度几乎同步，能在一个时钟周期内完成数据的读写操作。</li>\n  <li><strong>L2缓存</strong>：二级缓存的容量比L1缓存大，一般在几百KB到几MB之间。它的速度比L1缓存稍慢，但仍然比内存快很多。L2缓存的作用是进一步扩大缓存容量，当L1缓存未命中时，会在L2缓存中查找数据。</li>\n  <li><strong>L3缓存</strong>：三级缓存的容量最大，通常在几MB到几十MB之间。L3缓存是多个核心共享的缓存，它的速度比L2缓存慢，但比内存快。当L2缓存未命中时，会在L3缓存中查找数据。</li>\n</ul>\n<h3>缓存映射方式</h3>\n<p>缓存与主存之间的数据映射方式主要有以下三种：</p>\n<ul>\n  <li><strong>直接映射</strong>：主存中的每一个块只能映射到缓存中的一个特定位置。这种映射方式实现简单，硬件成本低，但灵活性较差，容易出现冲突，导致缓存命中率降低。</li>\n  <li><strong>全相联映射</strong>：主存中的任意一个块可以映射到缓存中的任意一个位置。这种映射方式灵活性高，缓存命中率高，但硬件实现复杂，成本高，因为需要在缓存中进行全搜索来确定数据是否存在。</li>\n  <li><strong>组相联映射</strong>：是直接映射和全相联映射的折中方案。将缓存分为若干组，主存中的块先映射到缓存的特定组，然后在该组内可以任意存放。组相联映射既具有一定的灵活性，又降低了硬件实现的复杂度。</li>\n</ul>\n<h3>缓存写策略</h3>\n<p>当CPU对缓存中的数据进行写操作时，需要考虑如何将数据更新到主存中，常见的写策略有以下两种：</p>\n<ul>\n  <li><strong>写直达（Write - Through）</strong>：在对缓存进行写操作的同时，将数据立即写入主存。这种策略的优点是主存和缓存的数据始终保持一致，可靠性高；缺点是写操作速度慢，因为每次写操作都需要访问主存。</li>\n  <li><strong>写回（Write - Back）</strong>：只在缓存中进行写操作，当该缓存块被替换时，才将其写回主存。这种策略的优点是写操作速度快，因为大部分写操作只需要在缓存中完成；缺点是主存和缓存的数据可能不一致，需要额外的硬件来管理缓存块的状态。</li>\n</ul>\n<h3>重要性</h3>\n<p>CPU缓存对于提高计算机系统的性能至关重要。通过缓存的使用，CPU可以在大多数情况下快速获取所需的数据，减少了CPU等待数据从内存传输的时间，从而提高了CPU的利用率和整个系统的运行效率。在现代计算机中，CPU缓存已经成为提高系统性能的关键技术之一。</p>",
  "type":6,
  "level":1,
  "freq":0.05007587,
  "analysis":"<h3>1. 题目核心</h3>\n<ul>\n  <li><strong>问题</strong>：介绍CPU缓存。</li>\n  <li><strong>考察点</strong>：\n    <ul>\n      <li>CPU缓存的概念和作用。</li>\n      <li>CPU缓存的层级结构。</li>\n      <li>CPU缓存的工作原理。</li>\n      <li>CPU缓存的映射方式。</li>\n      <li>CPU缓存的一致性问题。</li>\n    </ul>\n  </li>\n</ul>\n<h3>2. 背景知识</h3>\n<h4>（1）CPU与内存速度差异</h4>\n<p>CPU的运算速度极快，而内存的读写速度相对较慢。这种速度上的巨大差异会导致CPU在等待从内存中读取数据时处于空闲状态，降低了CPU的使用效率。</p>\n<h4>（2）局部性原理</h4>\n<p>程序在执行过程中，具有时间局部性（近期被访问过的数据很可能在不久的将来再次被访问）和空间局部性（被访问数据附近的数据很可能也会被访问）。基于局部性原理，可以将近期可能会使用的数据提前存储在高速的存储区域，以提高数据的访问速度。</p>\n<h3>3. 解析</h3>\n<h4>（1）CPU缓存的概念和作用</h4>\n<p>CPU缓存是位于CPU和主内存之间的高速存储区域，其读写速度比主内存快很多。它的主要作用是缓解CPU和主内存之间的速度差异，提高CPU访问数据的效率，减少CPU等待数据从内存传输的时间，从而提升整个计算机系统的性能。</p>\n<h4>（2）CPU缓存的层级结构</h4>\n<p>现代CPU通常采用多级缓存结构，一般分为L1、L2和L3缓存：</p>\n<ul>\n  <li><strong>L1缓存</strong>：离CPU核心最近，速度最快，但容量最小。它又分为数据缓存（L1 - D）和指令缓存（L1 - I），分别用于存储数据和指令，以提高数据和指令的读取效率。</li>\n  <li><strong>L2缓存</strong>：速度次之，容量比L1缓存大。它是L1缓存的补充，当L1缓存中没有所需的数据时，会从L2缓存中查找。</li>\n  <li><strong>L3缓存</strong>：速度相对L1和L2缓存较慢，但容量更大。多个CPU核心通常共享L3缓存，它可以进一步减少对主内存的访问。</li>\n</ul>\n<h4>（3）CPU缓存的工作原理</h4>\n<p>当CPU需要访问数据时，首先会在L1缓存中查找，如果找到则直接使用，这称为缓存命中；如果L1缓存中没有，则会到L2缓存中查找，以此类推。如果所有缓存中都没有所需的数据，就会从主内存中读取数据，并将数据同时存入各级缓存中，以便后续访问。</p>\n<h4>（4）CPU缓存的映射方式</h4>\n<ul>\n  <li><strong>直接映射</strong>：主存中的每个块只能映射到缓存中的一个特定位置。这种映射方式实现简单，但容易产生冲突，导致缓存命中率降低。</li>\n  <li><strong>全相联映射</strong>：主存中的任何一个块可以映射到缓存中的任意位置。这种方式灵活性高，缓存命中率高，但实现复杂，成本较高。</li>\n  <li><strong>组相联映射</strong>：是直接映射和全相联映射的折中方案。将缓存分为若干组，主存中的块可以映射到缓存中特定组内的任意位置。</li>\n</ul>\n<h4>（5）CPU缓存的一致性问题</h4>\n<p>在多核心CPU系统中，每个核心都有自己的缓存。当一个核心修改了缓存中的数据时，其他核心的缓存中可能存在相同数据的旧副本，这就导致了缓存一致性问题。为了解决这个问题，通常采用MESI协议等缓存一致性协议，确保各个核心的缓存数据保持一致。</p>\n<h3>4. 示例说明</h3>\n<p>假设一个程序需要频繁访问数组中的元素。当程序第一次访问数组的某个元素时，该元素会从主内存加载到各级缓存中。后续再次访问该元素或其附近的元素时，就可以直接从缓存中读取，大大提高了访问速度。例如，在一个循环中对数组元素进行累加操作，由于数组元素具有空间局部性，大部分访问都可以在缓存中命中，避免了频繁访问主内存。</p>\n<h3>5. 常见误区</h3>\n<h4>（1）认为缓存越大越好</h4>\n<p>虽然较大的缓存可以存储更多的数据，提高缓存命中率，但缓存的大小也会影响成本和功耗。而且，缓存命中率不仅仅取决于缓存大小，还与程序的局部性特征等因素有关。</p>\n<h4>（2）忽视缓存一致性问题</h4>\n<p>在多核心系统中，如果不考虑缓存一致性问题，可能会导致程序出现数据不一致的错误。因此，在编写多线程或多核心程序时，需要正确处理缓存一致性。</p>\n<h3>6. 总结回答</h3>\n<p>CPU缓存是位于CPU和主内存之间的高速存储区域，用于缓解CPU和主内存之间的速度差异，提高系统性能。现代CPU通常采用多级缓存结构，包括L1、L2和L3缓存，各级缓存速度和容量不同。</p>\n<p>CPU缓存的工作原理基于局部性原理，当CPU需要访问数据时，先在缓存中查找，若命中则直接使用，未命中则从主内存读取并将数据存入缓存。缓存的映射方式有直接映射、全相联映射和组相联映射。</p>\n<p>在多核心系统中，存在缓存一致性问题，需要采用缓存一致性协议来解决。需要注意的是，缓存并非越大越好，且在多核心编程时要重视缓存一致性问题。</p>",
  "more_ask":"<ol>\n  <li><strong>缓存一致性协议的工作原理是什么</strong>：提示可从多个CPU核心对同一缓存行操作时如何保证数据一致性的角度思考，比如MESI协议中不同状态的转换。</li>\n  <li><strong>如何衡量CPU缓存的性能</strong>：提示考虑命中率、缺失率、访问延迟等关键指标，以及它们之间的相互关系。</li>\n  <li><strong>缓存预取技术有哪些，原理是什么</strong>：提示预取是为了提前将数据加载到缓存，可从硬件预取和软件预取两方面去想。</li>\n  <li><strong>多级缓存之间是如何协同工作的</strong>：提示思考数据在不同级缓存（如L1、L2、L3）之间的流动和交互机制。</li>\n  <li><strong>CPU缓存对程序性能有哪些具体影响</strong>：提示结合代码中的数据访问模式、循环结构等，分析缓存命中和缺失对程序运行速度的影响。</li>\n</ol>",
  "mindmap":"mindmap\n  root((CPU缓存))\n    工作原理\n      局部性原理\n        时间局部性\n        空间局部性\n      访问流程\n        命中\n        未命中\n    层级结构\n      L1缓存\n        数据缓存（L1 - D）\n        指令缓存（L1 - I）\n        容量\n        速度\n      L2缓存\n        容量\n        速度\n        作用\n      L3缓存\n        容量\n        共享性\n        速度\n        作用\n    缓存映射方式\n      直接映射\n        特点\n      全相联映射\n        特点\n      组相联映射\n        特点\n    缓存写策略\n      写直达（Write - Through）\n        优点\n        缺点\n      写回（Write - Back）\n        优点\n        缺点\n    重要性\n      提高CPU利用率\n      提高系统运行效率",
  "keynote":"工作原理：基于局部性原理（时间、空间局部性），CPU先查缓存，命中则读，未命中从内存读并存缓存\n层级结构：L1（分数据和指令缓存，容量小速度快）、L2（容量较大，速度稍慢）、L3（容量最大，多核心共享）\n缓存映射方式：直接映射（实现简单，灵活性差）、全相联映射（灵活性高，硬件复杂）、组相联映射（折中方案）\n缓存写策略：写直达（数据一致，写操作慢）、写回（写操作快，数据可能不一致）\n重要性：提高CPU利用率和系统运行效率",
  "group_id":8,
  "kps":["缓存技术"],
  "years":[2025,2024,2023,2022],
  "corps":["华为","腾讯","网易","字节跳动","美团","砺算科技"]};

const PROBLEM_DETAIL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS problem_details (
    id INTEGER PRIMARY KEY,
    category_id INTEGER,
    type INTEGER,
    level INTEGER,
    frequency REAL,
    name_html TEXT,
    options_json TEXT,
    answer_html TEXT,
    analysis_html TEXT,
    more_ask_html TEXT,
    mindmap_text TEXT,
    keynote_html TEXT,
    kps_json TEXT,
    years_json TEXT,
    corps_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function toIntOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toFloatOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringifyOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJsonArray(value) {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function initProblemDetailSchema(pool) {
  await pool.withConnection((db) => db.exec(PROBLEM_DETAIL_TABLE_SQL));
}

export async function createProblemDetailUpserter(db) {
  const stmt = await db.prepare(`
    INSERT INTO problem_details (
      id, category_id,
      name_html, options_json, answer_html, analysis_html,
      more_ask_html, mindmap_text, keynote_html,
      kps_json, years_json, corps_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      category_id = excluded.category_id,
      name_html = excluded.name_html,
      options_json = excluded.options_json,
      answer_html = excluded.answer_html,
      analysis_html = excluded.analysis_html,
      more_ask_html = excluded.more_ask_html,
      mindmap_text = excluded.mindmap_text,
      keynote_html = excluded.keynote_html,
      kps_json = excluded.kps_json,
      years_json = excluded.years_json,
      corps_json = excluded.corps_json,
      updated_at = datetime('now')
  `);

  return {
    async upsert(problem) {
      const params = [
        toIntOrNull(problem?.id),
        toIntOrNull(problem?.group_id),
        typeof problem?.name === 'string' ? problem.name : null,
        stringifyOrNull(problem?.options),
        typeof problem?.answer === 'string' ? problem.answer : null,
        typeof problem?.analysis === 'string' ? problem.analysis : null,
        typeof problem?.more_ask === 'string' ? problem.more_ask : null,
        typeof problem?.mindmap === 'string' ? problem.mindmap : null,
        typeof problem?.keynote === 'string' ? problem.keynote : null,
        stringifyOrNull(problem?.kps),
        stringifyOrNull(problem?.years),
        stringifyOrNull(problem?.corps),
      ];

      return stmt.run(params);
    },
    finalize() {
      return stmt.finalize();
    },
  };
}

export async function upsertProblemDetail(pool, problem) {
  return pool.withConnection(async (db) => {
    const upserter = await createProblemDetailUpserter(db);
    try {
      return await upserter.upsert(problem);
    } finally {
      await upserter.finalize();
    }
  });
}

function rowToProblem(row) {
  if (!row) return undefined;

  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name_html,
    answer: row.answer_html,
    analysis: row.analysis_html,
    moreAsk: row.more_ask_html,
    mindmap: row.mindmap_text,
    keynote: row.keynote_html,
    options: row?.options_json ? parseJsonArray(row.options_json) : undefined,
    keyPoints: row?.kps_json ? parseJsonArray(row.kps_json) : undefined,
    companies: row?.corps_json ? parseJsonArray(row.corps_json) : undefined,
    years: row?.years_json ? parseJsonArray(row.years_json) : undefined,
  };
}

export async function getProblemDetailById(pool, id) {
  return pool.withConnection(async (db) => {
    const row = await db.get(`SELECT * FROM problem_details WHERE id = ?`, [toIntOrNull(id)]);
    if (!row) return undefined;

    return rowToProblem(row);
  });
}

export async function upsertProblemAnswerById(pool, {
  id,
  categoryId,
  name,
  answer,
  keyPoints,
  companies,
  years,
} = {}) {
  const problemId = toIntOrNull(id);
  if (problemId == null) throw new Error('Invalid problem id');

  const answerHtml = typeof answer === 'string' ? answer.trim() : '';
  if (!answerHtml) throw new Error('Answer is empty');

  return pool.withConnection(async (db) => db.run(
    `
      INSERT INTO problem_details (id, category_id, name_html, answer_html, kps_json, years_json, corps_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        answer_html = excluded.answer_html,
        kps_json = excluded.kps_json,
        years_json = COALESCE(excluded.years_json, problem_details.years_json),
        corps_json = excluded.corps_json,
        updated_at = datetime('now')
    `,
    [
      problemId,
      toIntOrNull(categoryId),
      typeof name === 'string' ? name : null,
      answerHtml,
      stringifyOrNull(keyPoints),
      stringifyOrNull(years),
      stringifyOrNull(companies),
    ],
  ));
}
