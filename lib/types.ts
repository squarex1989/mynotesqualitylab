// No gender dimension — the voice itself determines it
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

export interface TtsModelInfo {
  id: string;
  label: string;
  note: string;
}

export interface RoomSummary {
  id: string;
  title: string | null;
  locked: boolean;
  status: 'idle' | 'playing';
  createdAt: number;
  lineCount: number;
  speakerCount: number;
}

export interface CompareMeta {
  products: { id: string; label: string }[];
  /** 留给 LLM 的两个问题；其余维度都由 code 算 */
  questions: { key: string; label: string; ask: string }[];
  judges: { id: string; label: string; model: string }[];
  /** Non-null when OPENROUTER_API_KEY is missing or looks wrong */
  problem: string | null;
}

export interface JudgeResult {
  judge: string;
  label: string;
  model: string;
  summary: string;
  usage?: unknown;
}

/** 编辑距离算出来的逐字指标，不经过模型 */
export interface WerMetrics {
  mode: 'word' | 'char';
  /** 中日文按字算，所以指标名是 CER */
  metric?: 'WER' | 'CER';
  refTokens: number;
  hypTokens: number;
  substitutions?: number;
  deletions?: number;
  insertions?: number;
  hits?: number;
  wer?: number;
  accuracy?: number;
  substitutionRate?: number;
  deletionRate?: number;
  insertionRate?: number;
  /** 文本太长走了分块近似对齐 */
  approximate?: boolean;
  /** 真值为空，算不出来 */
  unavailable?: boolean;
}

/** 三档权重下的错误率：语气词 ×0.1、普通 ×1、名字/数字/否定词 ×3 */
export interface WeightedMetrics {
  metric: string;
  wer: number;
  substitutionRate: number;
  deletionRate: number;
  insertionRate: number;
  /** 关键词里有多少比例被录错或漏掉 */
  keyErrorRate: number | null;
  keyTokens: number;
  fillerTokens: number;
  normalTokens: number;
  weights: { filler: number; normal: number; key: number };
}

export interface TermOutcome {
  term: string;
  source: string;
  total: number;
  correct: number;
  dropped: number;
  wrong: { got: string; count: number; line: number }[];
}

export interface TermReport {
  checked: number;
  occurrences: number;
  clean: number;
  issues: TermOutcome[];
}

export interface SpeakerReport {
  unavailable?: boolean;
  reason?: string;
  /** 候选转录里完全没有说话人标签 —— 和「分错了」是两回事 */
  unlabeled?: boolean;
  refSpeakers?: {
    name: string;
    tokens: number;
    mappedTo: string | null;
    matched: number;
    strays: { label: string; tokens: number }[];
  }[];
  candLabels?: { label: string; tokens: number }[];
  alignedTokens?: number;
  misattributed?: number;
  attributionAccuracy?: number | null;
  labelCountDelta?: number;
  splits?: { speaker: string; labels: { label: string; tokens: number }[] }[];
  merges?: { label: string; tokens: number; speakers: string[] }[];
}

/** code 侧先标出来的线索：否定词被漏掉、数字变了 */
export interface Lead {
  kind: string;
  line: number;
  speaker: string | null;
  reference: string;
  candidate: string;
  detail: string;
}

export interface CodeMetrics {
  wer: WerMetrics;
  unavailable?: boolean;
  weighted?: WeightedMetrics;
  properNouns?: TermReport;
  numbers?: TermReport;
  speakers?: SpeakerReport;
  glossaryTerms?: number;
  leads?: Lead[];
  totalDiffRuns?: number;
  hunksTruncated?: boolean;
}

/** LLM 输出的一条证据。不打分 —— 证据能核对，分数不能。 */
export interface Finding {
  hunk: number;
  reference: string;
  candidate: string;
  severity: 'critical' | 'minor';
  why: string;
  /** 哪个裁判报的；两个都报的最可信 */
  sources: string[];
}

export interface CompareResult {
  metrics: CodeMetrics;
  evidence: Record<string, Finding[]>;
  critical?: number;
  judges: JudgeResult[];
  failures: { judge?: string; label: string; message: string }[];
  judgesUnavailable?: boolean;
}

export interface Comparison {
  product: string;
  transcript: string;
  result: CompareResult | null;
  state: 'idle' | 'scoring' | 'done' | 'failed';
  error: string | null;
  updatedAt: number;
}

export interface Meta {
  voices: VoiceInfo[];
  dimensions: Record<DimensionKey, Dimension>;
  models: TtsModelInfo[];
  defaultModel: string;
  /** Voice list is still the built-in fallback (fetch-fish-voices hasn't been run) */
  fallbackVoices: boolean;
  titleMaxWeight: number;
  ttsConfigured: boolean;
  ttsProblem: string | null;
  compare: CompareMeta;
}

export interface Speaker {
  name: string;
  voice: string;
  config: Record<DimensionKey, string>;
  configLabels: Record<DimensionKey, string>;
  instructions: string;
  custom: boolean;
  /** Playback gain in percent (0 = muted, else 20–100). Not part of the audio cache key. */
  volume: number;
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
  ambienceUrlCafe: string | null;
  ambienceUrlAirport: string | null;
  /** Derived: whichever URL matches the selected scene */
  ambienceUrl: string | null;
  ambienceVolume: number;
  ambienceDevice: string | null;
  /** Listens only — plays nothing and is never assigned a speaker */
  captureDevice: string | null;
  /** Names and product terms, one per line — weighted highest when scoring */
  glossary: string;
  ttsModel: string;
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
  comparisons: Comparison[];
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
  /** 0–1 playback gain for this speaker */
  volume: number;
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
