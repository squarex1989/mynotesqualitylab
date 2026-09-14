// 没有 gender —— 性别由 voice 决定，音色下拉里就标着男声/女声
export type DimensionKey = 'age' | 'tone' | 'accent' | 'pace' | 'emotion' | 'quirk';

export interface DimensionOption {
  value: string;
  label: string;
  prompt: string;
}

export interface Dimension {
  label: string;
  options: DimensionOption[];
}

export interface VoiceInfo {
  id: string;
  label: string;
  gender: 'male' | 'female' | 'neutral';
  note: string;
  tags?: string[];
  languages?: string[];
}

export interface Meta {
  voices: VoiceInfo[];
  dimensions: Record<DimensionKey, Dimension>;
  model: string;
  /** 音色表还是内置兜底的（没跑过 fetch-fish-voices） */
  fallbackVoices: boolean;
  ttsConfigured: boolean;
  ttsProblem: string | null;
}

export interface Speaker {
  name: string;
  voice: string;
  config: Record<DimensionKey, string>;
  configLabels: Record<DimensionKey, string>;
  instructions: string;
  custom: boolean;
  deviceId: string | null;
  lineCount: number;
  sampleHash: string | null;
}

export interface Device {
  id: string;
  name: string;
  isHost: boolean;
  online: boolean;
  audioReady?: boolean;
}

export interface RoomSettings {
  orderMode: 'ordered' | 'chaotic';
  noiseMode: 'quiet' | 'noisy';
  ambienceKind: 'cafe' | 'airport';
  ambienceUrl: string | null;
  ambienceVolume: number;
  ambienceDevice: string | null;
  gapMs: number;
  chaosPeriodMs: number;
  duckGain: number;
}

export interface RoomState {
  id: string;
  title: string | null;
  locked: boolean;
  status: 'idle' | 'playing';
  hostDevice: string | null;
  settings: RoomSettings;
  speakers: Speaker[];
  devices: Device[];
  lineCount: number;
}

export interface Progress {
  ready: number;
  total: number;
  mask: number[];
  generating: boolean;
  failures: { idx: number; message: string }[];
}

export interface Line {
  idx: number;
  speaker: string;
  content: string;
}

export interface ScheduleItem {
  idx: number;
  speaker: string;
  deviceId: string | null;
  hash: string;
  startMs: number;
  durationMs: number;
  overlapMs: number;
  duckFromMs: number | null;
  duckGain: number;
}

export interface AmbienceConfig {
  deviceId: string | null;
  url: string;
  kind: 'cafe' | 'airport';
  volume: number;
}

export interface PreparePayload {
  token: string;
  items: ScheduleItem[];
  totalMs: number;
  overlaps: number;
  orderMode: 'ordered' | 'chaotic';
  ambience: AmbienceConfig | null;
}

export interface ParsePreview {
  speakers: string[];
  candidates: { name: string; count: number }[];
  warnings: string[];
  format: string;
  lineCount: number;
  preview: { speaker: string; content: string }[];
  charCount: number;
}
