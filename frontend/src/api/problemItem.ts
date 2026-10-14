import { get,post } from '@/utils/request';

export interface Problem {
  time: string; // 数据更新时间
  url: string;  // 题目链接
  id: number;
  name: string; // 题目
  briefName: string; // 题目简短名称
  options: string[] | null; // 题目选项，多选题或单选题才有值
  type: number;
  keyPoints: string[];   // 知识点标签
  years: string[] | null; // 哪些年份考察了该题
  level:number; // 题目难度等级 1：简单 2：中等 3：困难
  freq: number;  // 题目被考察频率
  categoryId: string; // 题目分组ID
  answer: string;   // 题目答案（C41 后可为三字段 JSON 字符串；旧数据可能为 HTML）
  /** C41/C42 解析结论（generate/详情顶层字段；与题目标签 keyPoints 无关） */
  summary?: string;
  /** C41/C42 解析下一步建议 */
  nextStep?: string;
  analysis: string; // 题目分析和考察要点归总
  moreAsk: string;  // 相关拓展问题
  mindmap: string;  // 思维导图文字，应该可以被组件渲染成思维导图
  companies:string[]; // 哪些公司考察了该题
}

export interface CreateProblemBody {
  id: number,
  name: string,
  answer: string,
}

export function getProblemById(id: string | number) {
  return get<Problem>(`/problems/${id}`, undefined, { cache: false });
}

export function createProblem(data: CreateProblemBody) {
  return post<Problem>(`/problems`, { data });
}

export interface GenerateProblemAnswerResponse {
  id: number;
  answer: string;
  cached: boolean;
  /** C41 冻约：简短结论 */
  summary?: string;
  /** C41 冻约：分点说明（勿与题目标签 Problem.keyPoints 混淆） */
  keyPoints?: string[];
  /** C41 冻约：下一步建议 */
  nextStep?: string;
}

export function generateProblemAnswer(id: string | number, options?: { force?: boolean }) {
  return post<GenerateProblemAnswerResponse>(`/problems/${id}/answer/generate`, {
    force: options?.force === true,
  }, {
    timeout: 120000,
  });
}
