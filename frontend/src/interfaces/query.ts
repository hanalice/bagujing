export interface QueryParams {
  keyword?: string;
  category?: number | string;
  groupName?: string;
  groupNames?: string[];
  company?: string;
  level?: string | number;
  freqRange?: string;
  keyPoint?: string;
  cursor?: string | number;
  limit?: number | string;
  offset?: number | string;
  order?: 'asc' | 'desc';
  sort?: string;
  [key: string]: any;
}
