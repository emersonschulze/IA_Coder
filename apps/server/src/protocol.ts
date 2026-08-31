/**
 * Contrato entre servidor e interface. Espelhado em apps/web/src/types.
 * Documentação em docs/PROTOCOLO.md.
 */

export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export type BlockState = 'queued' | 'running' | 'done' | 'error';
export type WorkflowState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
export type LogLevel = 'info' | 'ok' | 'warn' | 'error';
export type RefKind = 'agent' | 'skill' | 'block' | 'archive';
export type RuntimeStatus = 'stopped' | 'starting' | 'ready' | 'thinking' | 'error';

export interface Ref { kind: RefKind; id: string }

export interface Agent {
  id: string; name: string; role: string; initials?: string; color: string;
  state: AgentState; progress?: number; skillId?: string | null;
  /** De onde ele veio: o nome do plugin, "projeto" ou "pessoal". */
  source?: string;
}
export interface Skill {
  id: string; name: string; detail: string; initials?: string; color: string; inUse: boolean;
  source?: string;
  /**
   * "tool" é grupo de ferramentas do próprio Claude Code (leitura, edição…);
   * "skill" é uma skill de verdade, instalada por plugin ou pelo `.claude`.
   */
  kind?: 'tool' | 'skill';
}
export interface Workflow {
  id: string; title: string; state: WorkflowState;
  step: number; totalSteps: number; progress: number; etaSeconds?: number; startedAt?: number;
}
export interface LogEntry { ts: number; level: LogLevel; text: string }
export interface Artifact {
  id: string; name: string; kind: string; href?: string; createdAt: number;
}
export interface Block {
  id: string; agentId: string; index: number; action: string; skillId: string | null;
  state: BlockState; progress: number; logs: LogEntry[]; artifacts: Artifact[];
}
export interface Link {
  id: string; from: Ref; to: Ref; label?: string; color?: string;
}
export interface Usage {
  tokensUsed: number; tokensLimit: number; contextPct: number; costUsd: number; plan: string;
  /** Consumo da janela de 5 horas da CONTA, 0..100 — vem da própria Anthropic, não desta sessão. */
  windowPct?: number;
  windowResetsAt?: number;
  /** Consumo da janela semanal da CONTA, 0..100 — idem. */
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
  method?: string;
  checkedAt: number;
  error?: string;
  reason?: 'expired' | 'missing';
}

/** Por que o Tree está do jeito que está. */
export type TreeStatus = 'ok' | 'unreachable' | 'schema-missing' | 'connecting';

export type ComponentKind =
  | 'microfrontend' | 'microservice' | 'api' | 'database' | 'cache'
  | 'queue' | 'job' | 'external' | 'library' | 'infra';

/** Nível 1: um assunto confirmado pelo usuário. */
export interface SubjectNode {
  id: string; slug: string; label: string; summary: string;
  tags: string[]; hits: number; components: number;
}
export interface SubjectEdge { from: string; to: string; kind: string }
export interface SubjectGraph { nodes: SubjectNode[]; edges: SubjectEdge[] }

/** Nível 2: a stack por dentro de um assunto. */
export interface ComponentNode {
  id: string; key: string; label: string; kind: ComponentKind; detail?: string;
}
export interface ComponentEdge { from: string; to: string; kind: string; label?: string }
export interface SubjectDetail {
  subject: SubjectNode; nodes: ComponentNode[]; edges: ComponentEdge[];
}
export interface SessionInfo {
  id: string;
  startedAt: number;
  runtime: string;
  plan: string;
  /** Versão do servidor, para a interface saber com quem está falando. */
  version: string;
  /**
   * O que este servidor sabe fazer. A interface usa isto para dizer com
   * precisão "o servidor é antigo" em vez de ficar adivinhando.
   */
  features: string[];
}

/** Estado do projeto e dos dois processos que rodam por trás. */
export interface ProjectState {
  path: string;
  name: string;
  recents: string[];
  exists: boolean;
  shell: { status: RuntimeStatus; error?: string | null };
  claude: { status: RuntimeStatus; sessionId?: string | null; model?: string | null; error?: string | null };
}

export interface DirEntry { name: string; path: string; isProject: boolean }
export interface Listing { path: string; parent: string | null; entries: DirEntry[]; error?: string }

export type ServerEvent =
  | { type: 'session.hello'; session: SessionInfo }
  | { type: 'agents.sync'; agents: Agent[] }
  | { type: 'skills.sync'; skills: Skill[] }
  | { type: 'agent.state'; agentId: string; state: AgentState; progress?: number; skillId?: string | null }
  | { type: 'skill.state'; skillId: string; inUse: boolean }
  | { type: 'workflow.started'; workflow: Workflow }
  | { type: 'workflow.updated'; patch: Partial<Workflow> & { id: string } }
  | { type: 'workflow.finished'; id: string; state: WorkflowState; summary?: string }
  | { type: 'block.upsert'; block: Block }
  | { type: 'block.patch'; patch: Partial<Block> & { id: string } }
  | { type: 'block.log'; blockId: string; entry: LogEntry }
  | { type: 'block.artifact'; blockId: string; artifact: Artifact }
  | { type: 'link.activated'; link: Link }
  | { type: 'link.deactivated'; linkId: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'tree.subjects'; graph: SubjectGraph; status: TreeStatus }
  | { type: 'tree.detail'; detail: SubjectDetail | null }
  | { type: 'knowledge.saved'; id: string; title: string }
  | { type: 'archives.sync'; archives: Artifact[] }
  | { type: 'archive.added'; archive: Artifact }
  | { type: 'assistant.say'; text: string; speak?: boolean }
  | { type: 'project.state'; project: ProjectState }
  | { type: 'project.listing'; listing: Listing }
  | { type: 'project.picked'; path: string | null; error?: string }
  | { type: 'auth.state'; auth: AuthState }
  | { type: 'voice.health'; health: VoiceHealth }
  | { type: 'conversation.state'; state: ConversationState }
  | { type: 'conversation.turn'; role: 'user' | 'agent'; text: string; images?: ImageAttachment[] }
  | { type: 'conversation.say'; text: string }
  | { type: 'auth.login.line'; line: string }
  | { type: 'auth.login.done'; ok: boolean; urls: string[] }
  | { type: 'pong' }
  | { type: 'error'; message: string };

export type ClientCommand =
  | { type: 'prompt.submit'; text: string; source: 'text' | 'voice' }
  | { type: 'workflow.cancel'; id: string }
  | { type: 'agent.inspect'; agentId: string }
  | { type: 'project.set'; path: string }
  | { type: 'project.browse'; path?: string }
  | { type: 'project.roots' }
  | { type: 'runtime.restart'; target: 'shell' | 'claude' | 'both' }
  | { type: 'project.pick' }
  | { type: 'conversation.start' }
  | { type: 'conversation.stop' }
  | { type: 'conversation.input'; text: string; images?: ImageAttachment[] }
  | { type: 'conversation.confirm'; accept: boolean }
  | { type: 'auth.check' }
  | { type: 'auth.login'; mode?: 'shell' | 'window' }
  | { type: 'artifact.open'; path: string; reveal?: boolean }
  | { type: 'tree.list' }
  | { type: 'tree.open'; subjectId: string }
  | { type: 'knowledge.save' }
  | { type: 'knowledge.forget'; subjectId: string }
  | { type: 'ping' };
