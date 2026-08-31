/** Modelos de domínio do IA_Coder. Espelham o que o servidor envia. */

export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export type BlockState = 'queued' | 'running' | 'done' | 'error';
export type WorkflowState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

/** Referência a qualquer entidade que possa receber uma seta. */
export type RefKind = 'agent' | 'skill' | 'block' | 'archive';
export interface Ref {
  kind: RefKind;
  id: string;
}

export interface Agent {
  id: string;
  name: string;
  /** Ex.: "API · DOMÍNIO · EF" */
  role: string;
  /** 2 letras do avatar. Se ausente, derivamos do nome. */
  initials?: string;
  /** Cor de identidade do agente (hex). Define o glow e a cor da seta. */
  color: string;
  state: AgentState;
  /** 0..100 — progresso da tarefa atual. */
  progress?: number;
  /** Skill que ele está usando agora. */
  skillId?: string | null;
  /** De onde ele veio: o nome do plugin, "projeto" ou "pessoal". */
  source?: string;
}

export interface Skill {
  id: string;
  name: string;
  detail: string;
  initials?: string;
  color: string;
  inUse: boolean;
  source?: string;
  /**
   * "tool" é grupo de ferramentas do Claude Code (leitura, edição…); "skill" é
   * uma skill instalada de verdade, por plugin ou pelo `.claude`.
   */
  kind?: 'tool' | 'skill';
}

export interface Workflow {
  id: string;
  /** O texto que o usuário digitou/falou. */
  title: string;
  state: WorkflowState;
  step: number;
  totalSteps: number;
  /** 0..100 */
  progress: number;
  etaSeconds?: number;
  startedAt?: number;
}

export interface LogEntry {
  ts: number;
  level: LogLevel;
  text: string;
}

export interface Artifact {
  id: string;
  name: string;
  /** md | png | pptx | code | json … usado só para escolher o ícone */
  kind: string;
  /** Caminho no disco ou URL, para abrir com um clique. */
  href?: string;
  createdAt: number;
}

export interface Block {
  id: string;
  agentId: string;
  index: number;
  /** O que o agente está fazendo neste instante. */
  action: string;
  skillId: string | null;
  state: BlockState;
  progress: number;
  logs: LogEntry[];
  artifacts: Artifact[];
}

export interface Link {
  id: string;
  from: Ref;
  to: Ref;
  label?: string;
  /** Sobrescreve a cor herdada da origem. */
  color?: string;
}

export interface Usage {
  tokensUsed: number;
  tokensLimit: number;
  /** 0..100 */
  contextPct: number;
  costUsd: number;
  plan: string;
  /** Consumo da janela de 5 horas da CONTA (0..100) — vem da própria Anthropic. */
  windowPct?: number;
  windowResetsAt?: number;
  /** Consumo da janela semanal da CONTA (0..100) — idem. */
  weekPct?: number;
  weekResetsAt?: number;
  /** Quando estes números foram atualizados pela última vez. */
  updatedAt?: number;
}

/* ------------------------------------------------------------------ Tree -- */


/** Serviços de voz local que estão de pé. */
export interface VoiceHealth {
  /** Whisper: fala → texto. */
  stt: boolean;
  /** Piper: texto → fala. */
  tts: boolean;
  wakeWord: string;
}

/** Onde a conversa está agora. */
export interface ConversationState {
  active: boolean;
  thinking: boolean;
  /** Plano esperando o seu "pode ir". */
  pending: { title: string; steps: string[]; risk: 'low' | 'medium' | 'high' } | null;
}

/** Uma imagem anexada a uma mensagem — vai para o Claude junto do texto. */
export interface ImageAttachment {
  /** ex.: "image/png". */
  mediaType: string;
  /** base64, sem o prefixo "data:...;base64,". */
  data: string;
  name?: string;
}

/** Situação da credencial do Claude Code. */
export interface AuthState {
  loggedIn: boolean;
  /** oauth_token, api_key… */
  method?: string;
  checkedAt: number;
  error?: string;
  /** `expired` veio de um 401 de verdade; `missing` veio do CLI. */
  reason?: 'expired' | 'missing';
}

/** Por que o Tree está do jeito que está. */
export type TreeStatus = 'ok' | 'unreachable' | 'schema-missing' | 'connecting';

export type ComponentKind =
  | 'microfrontend' | 'microservice' | 'api' | 'database' | 'cache'
  | 'queue' | 'job' | 'external' | 'library' | 'infra';

/** Nível 1 — um assunto que o usuário confirmou que ficou bom. */
export interface SubjectNode {
  id: string;
  slug: string;
  label: string;
  summary: string;
  tags: string[];
  /** Quantas vezes esse assunto já foi reaproveitado como contexto. */
  hits: number;
  /** Quantos serviços existem no nível 2. */
  components: number;
}
export interface SubjectEdge { from: string; to: string; kind: string }
export interface SubjectGraph { nodes: SubjectNode[]; edges: SubjectEdge[] }

/** Nível 2 — a stack por dentro de um assunto. */
export interface ComponentNode {
  id: string;
  key: string;
  label: string;
  kind: ComponentKind;
  detail?: string;
}
export interface ComponentEdge { from: string; to: string; kind: string; label?: string }
export interface SubjectDetail {
  subject: SubjectNode;
  nodes: ComponentNode[];
  edges: ComponentEdge[];
}

export interface SessionInfo {
  id: string;
  startedAt: number;
  runtime: string;
  plan: string;
  /** Versão do servidor. Ausente = servidor anterior a 0.3.0. */
  version?: string;
  /** Comandos que o servidor entende: project, picker, tree, knowledge. */
  features?: string[];
}

/** Estado do projeto aberto e dos dois processos que rodam por trás dele. */
export type RuntimeStatus = 'stopped' | 'starting' | 'ready' | 'thinking' | 'error';

export interface ProjectState {
  path: string;
  name: string;
  recents: string[];
  exists: boolean;
  shell: { status: RuntimeStatus; error?: string | null };
  claude: {
    status: RuntimeStatus;
    sessionId?: string | null;
    model?: string | null;
    error?: string | null;
  };
}

export interface DirEntry {
  name: string;
  path: string;
  /** Tem .git, package.json, .sln… — sobe na lista. */
  isProject: boolean;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  error?: string;
}
