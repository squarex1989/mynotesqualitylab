import type { Meta, ParsePreview, RoomState, Progress, Line } from './types';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) throw new Error(body?.error || `请求失败 (${res.status})`);
  return body as T;
}

export const api = {
  meta: () => req<Meta>('/api/meta'),

  createRoom: (title?: string) =>
    req<{ id: string; hostToken: string }>('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),

  getRoom: (id: string) =>
    req<{ state: RoomState; progress: Progress }>(`/api/rooms/${encodeURIComponent(id)}`),

  getLines: (id: string) => req<{ lines: Line[] }>(`/api/rooms/${encodeURIComponent(id)}/lines`),

  previewTranscript: (text: string, mergeConsecutive: boolean, excludeSpeakers: string[] = []) =>
    req<ParsePreview>('/api/transcript/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, mergeConsecutive, excludeSpeakers }),
    }),

  uploadTranscript: (
    id: string,
    hostToken: string,
    text: string,
    mergeConsecutive: boolean,
    excludeSpeakers: string[] = []
  ) =>
    req<{ ok: true; lineCount: number; speakers: string[]; warnings: string[] }>(
      `/api/rooms/${encodeURIComponent(id)}/transcript`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-host-token': hostToken },
        body: JSON.stringify({ text, mergeConsecutive, excludeSpeakers }),
      }
    ),
};

export const audioUrl = (hash: string) => `/api/audio/${hash}.wav`;
