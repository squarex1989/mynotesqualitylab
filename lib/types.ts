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
  tags: string[];
  accents: string[];
  country: string;
  languages?: string[];
}

export interface CountryInfo {
  code: string;
  label: string;
  labelZh: string;
  count: number;
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
  /** Non-null when OPENROUTER_API_KEY is missing or looks wrong */
  problem: string | null;
  /** The single judge model (reference extraction, UER, summary verdicts) */
  model: string;
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
  /** 归一化之后一致的写法（NovaLedger vs Nova Ledger）—— 算对，但记下来 */
  variants: { got: string; count: number }[];
}

export interface TermReport {
  checked: number;
  occurrences: number;
  clean: number;
  issues: TermOutcome[];
  variants?: { term: string; variants: { got: string; count: number }[] }[];
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

/**
 * UER（Utterance Error Rate）—— 和 μ-bench 同口径。
 * 逐个错误判三档，再按句二值化：至少一个 significant 就算这句错了。
 */
export interface UerResult {
  metric?: 'UER';
  model?: string;
  unavailable?: boolean;
  reason?: string;
  /** 分母：参与打分的 utterance 数 */
  utterances?: number;
  utterancesWithErrors?: number;
  significantUtterances?: number;
  uer?: number | null;
  counts?: { significant: number; minor: number; none: number };
  /** 只列意思变了的那些 */
  errors?: {
    line: number;
    speaker: string | null;
    type: string;
    script: string;
    transcript: string;
    reason: string;
  }[];
  tokensUsed?: number;
  partial?: boolean;
  skipped?: number;
  failures?: string[];
}

/** EWER: WER restricted to entity words */
export interface EwerReport {
  ewer: number | null;
  entities: number;
  occurrences: number;
  substitutions: number;
  deletions: number;
  /** reference = entities extracted from the script; auto = capitalisation fallback */
  source: 'reference' | 'auto';
  errors: TermOutcome[];
}

export interface LanguageCheck {
  checkedLines: number;
  wrongLines: number;
  correctness: number | null;
  mismatches: { line: number; expected: string; got: string; script: string; transcript: string }[];
}

/** Transcript evaluation (version 2) */
export interface CompareResult {
  version?: number;
  metrics: CodeMetrics & { ewer?: EwerReport; languageCheck?: LanguageCheck };
  uer?: UerResult;
  headline?: {
    ewer?: number | null;
    uer?: number | null;
    wder?: number | null;
    wderUnlabeled?: boolean;
    language?: number | null;
    wer?: number | null;
  };
}

export type Verdict = 'supported' | 'partially_supported' | 'unsupported' | 'contradicted' | 'irrelevant';

export interface SummaryClaim {
  index: number;
  claim: string;
  section: string;
  verdict: Verdict;
  evidenceLines: number[];
  evidence: string;
  errorType: string;
  critical: boolean;
  criticalType: string;
}

export interface ActionItemEval {
  text: string;
  owner: string;
  due: string;
  deliverable: string;
  status: string;
  valid: boolean;
  invalidReason: string;
  matchedUnit: string;
  checks: Record<'owner' | 'due' | 'deliverable' | 'status', string>;
}

/** Summary + action item evaluation (version 2) */
export interface SummaryResult {
  version: number;
  model?: string;
  headline: {
    precision: number | null;
    recall: number | null;
    f1: number | null;
    critical: boolean;
    criticalCount: number;
    languageOk: boolean | null;
    actionPrecision: number | null;
    actionRecall: number | null;
    actionF1: number | null;
  };
  precision: { claims: number; byVerdict: Record<Verdict, number> };
  recall: { units: number; byType: Record<string, { recall: number | null; units: number }> };
  critical: { claims: number[]; omissions: string[]; types: Record<string, number> };
  errorTypes: Record<string, number>;
  diagnostics: {
    nameCorrectness: number | null;
    numberDateCorrectness: number | null;
    decisionCorrectness: number | null;
    attributionCorrectness: number | null;
    terminologyCorrectness: number | null;
    language: { expected: string | null; got: string | null };
  };
  actionItems: {
    extracted: number;
    valid: number;
    referenceActions: number;
    matched: number;
    attributeAccuracy: Record<'owner' | 'due' | 'deliverable' | 'status', number | null>;
    allAttributesCorrect: number | null;
    unsupportedAttributeRate: number | null;
    criticalCount: number;
    items: ActionItemEval[];
    missed: string[];
  };
  claims: SummaryClaim[];
  units: { id: string; type: string; importance: number; text: string; coverage: 'covered' | 'partial' | 'missing' }[];
  templateAlignment: { evaluated: boolean };
}

export interface ReferenceUnit {
  id: string;
  type: string;
  importance: number;
  text: string;
  lines: number[];
  owner: string;
  due: string;
  deliverable: string;
  status: string;
}

export interface RoomReference {
  entities: { text: string; type: string }[];
  units: ReferenceUnit[];
  model?: string;
}

export interface Comparison {
  product: string;
  transcript: string;
  /** The product's meeting summary */
  summary: string;
  result: CompareResult | null;
  state: 'idle' | 'scoring' | 'done' | 'failed';
  error: string | null;
  summaryResult: SummaryResult | null;
  summaryState: 'idle' | 'scoring' | 'done' | 'failed';
  summaryError: string | null;
  updatedAt: number;
}

export interface Meta {
  voices: VoiceInfo[];
  dimensions: Record<DimensionKey, Dimension>;
  models: TtsModelInfo[];
  defaultModel: string;
  /** Voice list is still the built-in fallback (fetch-fish-voices hasn't been run) */
  countries: CountryInfo[];
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
  /** Capture device: records the meeting for the products, never reads a line */
  capture: boolean;
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
  /** Paused on this line (idx); resuming starts from the beginning of it */
  pausedIdx?: number | null;
  /** Evaluation reference extracted from the script (cached per room) */
  reference?: RoomReference | null;
}

export interface ReportListItem {
  id: string;
  title: string;
  roomCount: number;
  state: 'running' | 'done' | 'failed';
  progress: { phase: string; done: number; total: number } | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface Stat {
  n: number;
  mean: number | null;
  median: number | null;
  sd: number | null;
  ci: [number, number] | null;
}

export interface ReportMetric {
  key: string;
  label: string;
  part: 'transcript' | 'summary';
  better: 'lower' | 'higher';
}

export interface ReportData {
  rooms: number;
  products: { id: string; label: string }[];
  baseline: string;
  metrics: ReportMetric[];
  overall: Record<string, Record<string, Stat>>;
  paired: Record<
    string,
    {
      rooms: number;
      means: Record<string, number | null>;
      vsBaseline: Record<
        string,
        { meanDiff: number | null; ci: [number, number] | null; n: number; otherBetter: number; baselineBetter: number; ties: number; stable: boolean }
      >;
    }
  >;
  groups: { key: string; title: string; buckets: { value: string; rooms: number; metrics: Record<string, Record<string, Stat>> }[] }[];
  errors: Record<
    string,
    {
      summaries: number;
      errorTypes: Record<string, number>;
      criticalTypes: Record<string, number>;
      topEntityErrors: { term: string; errors: number; dropped: number; rooms: number; gotAs: { got: string; count: number }[] }[];
    }
  >;
  worst: Record<
    string,
    {
      highestEwer: { id: string; title: string | null; value: number }[];
      highestUer: { id: string; title: string | null; value: number }[];
      lowestF1: { id: string; title: string | null; value: number }[];
      withCritical: { id: string; title: string | null; count: number }[];
    }
  >;
  missing: Record<string, { transcript: string[]; summary: string[] }>;
  perRoom: {
    id: string;
    title: string | null;
    language: string;
    speakers: number;
    order: string;
    noise: string;
    accent: string;
    accents: string[];
    values: Record<string, Record<string, number | null>>;
  }[];
}

export interface Report extends ReportListItem {
  roomIds: string[];
  options: { scoreMissing?: boolean };
  data: ReportData | null;
  aiSummary: string | null;
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

/** One file's outcome from the batch import on the home page */
export interface ImportResult {
  file: string;
  ok: boolean;
  error?: string;
  id?: string;
  hostToken?: string;
  title?: string | null;
  language?: string;
  speakerCount?: number;
  lineCount?: number;
  settings?: { orderMode: string; noiseMode: string; ambienceKind: string };
  accents?: string[];
  warnings?: string[];
}
