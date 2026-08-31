import { create } from 'zustand';
import type {
  Agent,
  AuthState,
  ConversationState,
  ImageAttachment,
  VoiceHealth,
  Artifact,
  Block,
  Link,
  Listing,
  ProjectState,
  SessionInfo,
  Skill,
  SubjectDetail,
  SubjectGraph,
  TreeStatus,
  Usage,
  Workflow,
} from '@/types/domain';
import type { ConnectionState, ServerEvent } from '@/types/protocol';

interface AssistantMessage {
  text: string;
  at: number;
}

interface SessionState {
  connection: ConnectionState;
  connectionDetail: string;
  session: SessionInfo | null;

  agents: Agent[];
  skills: Skill[];
  workflow: Workflow | null;
  blocks: Block[];
  links: Link[];
  /** Setas de pré-visualização geradas no cliente (hover), fora do fluxo do servidor. */
  previewLinks: Link[];
  usage: Usage;
  tree: SubjectGraph;
  /** Por que o Tree está vazio, quando está. */
  treeStatus: TreeStatus;
  treeDetail: SubjectDetail | null;
  archives: Artifact[];
  assistant: AssistantMessage | null;
  project: ProjectState | null;
  /** Situação da credencial do Claude Code. */
  auth: AuthState | null;
  /** Saída do `claude auth login` em andamento. */
  login: { lines: string[]; urls: string[]; running: boolean; ok?: boolean };
  /** Serviços de voz local que estão de pé. */
  voice: VoiceHealth | null;
  conversation: ConversationState;
  turns: { role: 'user' | 'agent'; text: string; at: number; images?: ImageAttachment[] }[];
  /** Última frase a ser falada em voz alta. */
  lastSay: { text: string; at: number } | null;
  /**
   * O que saiu de uma execução: o resumo e os arquivos gerados.
   * É isto que a Caixa de Texto mostra — conversa fica no painel de Conversa.
   */
  result: { text: string; at: number; artifacts: Artifact[] } | null;
  listing: Listing | null;
  /** Resultado da última tentativa de abrir o seletor de pastas do Windows. */
  pick: { at: number; path: string | null; error?: string } | null;
  lastError: string | null;

  setConnection: (state: ConnectionState, detail?: string) => void;
  setPreviewLinks: (links: Link[]) => void;
  apply: (event: ServerEvent) => void;
}

const EMPTY_USAGE: Usage = {
  tokensUsed: 0,
  tokensLimit: 0,
  contextPct: 0,
  costUsd: 0,
  plan: '—',
};

const patchById = <T extends { id: string }>(list: T[], patch: Partial<T> & { id: string }): T[] =>
  list.map((item) => (item.id === patch.id ? { ...item, ...patch } : item));

/** Mantém o log enxuto: só as últimas 200 linhas por bloco ficam na memória. */
const LOG_LIMIT = 200;

export const useSession = create<SessionState>((set) => ({
  connection: 'connecting',
  connectionDetail: '',
  session: null,

  agents: [],
  skills: [],
  workflow: null,
  blocks: [],
  links: [],
  previewLinks: [],
  usage: EMPTY_USAGE,
  tree: { nodes: [], edges: [] },
  treeStatus: 'connecting',
  treeDetail: null,
  archives: [],
  assistant: null,
  project: null,
  auth: null,
  login: { lines: [], urls: [], running: false },
  voice: null,
  conversation: { active: false, thinking: false, pending: null },
  turns: [],
  lastSay: null,
  result: null,
  listing: null,
  pick: null,
  lastError: null,

  setConnection: (connection, connectionDetail = '') => set({ connection, connectionDetail }),
  setPreviewLinks: (previewLinks) => set({ previewLinks }),

  apply: (event) =>
    set((state) => {
      switch (event.type) {
        case 'session.hello':
          return { session: event.session };

        case 'agents.sync':
          return { agents: event.agents };

        case 'skills.sync':
          return { skills: event.skills };

        case 'agent.state':
          return {
            agents: state.agents.map((agent) =>
              agent.id === event.agentId
                ? {
                    ...agent,
                    state: event.state,
                    progress: event.progress ?? agent.progress,
                    skillId: event.skillId !== undefined ? event.skillId : agent.skillId,
                  }
                : agent,
            ),
          };

        case 'skill.state':
          return {
            skills: state.skills.map((skill) =>
              skill.id === event.skillId ? { ...skill, inUse: event.inUse } : skill,
            ),
          };

        case 'workflow.started':
          // Execução nova zera o resultado anterior: nada de resposta velha na tela.
          return { workflow: event.workflow, blocks: [], links: [], result: null };

        case 'workflow.updated':
          return {
            workflow: state.workflow ? { ...state.workflow, ...event.patch } : state.workflow,
          };

        case 'workflow.finished': {
          // O resumo é a última coisa que o agente escreveu; os arquivos vêm
          // dos blocos. Juntos formam o "pronto, ficou assim".
          const artifacts = state.blocks.flatMap((block) => block.artifacts);
          return {
            workflow: state.workflow
              ? { ...state.workflow, state: event.state, progress: 100 }
              : state.workflow,
            links: [],
            result:
              event.state === 'cancelled'
                ? state.result
                : {
                    text: event.summary ?? state.assistant?.text ?? '',
                    at: Date.now(),
                    artifacts,
                  },
          };
        }

        case 'block.upsert': {
          const exists = state.blocks.some((block) => block.id === event.block.id);
          return {
            blocks: exists
              ? state.blocks.map((block) => (block.id === event.block.id ? event.block : block))
              : [...state.blocks, event.block].sort((a, b) => a.index - b.index),
          };
        }

        case 'block.patch':
          return { blocks: patchById(state.blocks, event.patch) };

        case 'block.log':
          return {
            blocks: state.blocks.map((block) =>
              block.id === event.blockId
                ? { ...block, logs: [...block.logs, event.entry].slice(-LOG_LIMIT) }
                : block,
            ),
          };

        case 'block.artifact':
          return {
            blocks: state.blocks.map((block) =>
              block.id === event.blockId
                ? { ...block, artifacts: [...block.artifacts, event.artifact] }
                : block,
            ),
          };

        case 'link.activated': {
          const others = state.links.filter((link) => link.id !== event.link.id);
          return { links: [...others, event.link] };
        }

        case 'link.deactivated':
          return { links: state.links.filter((link) => link.id !== event.linkId) };

        case 'usage':
          return { usage: event.usage };

        case 'tree.subjects':
          return { tree: event.graph, treeStatus: event.status };

        case 'tree.detail':
          return { treeDetail: event.detail };

        case 'knowledge.saved':
          return {};

        case 'archives.sync':
          return { archives: event.archives };

        case 'archive.added':
          return { archives: [event.archive, ...state.archives] };

        case 'assistant.say':
          return { assistant: { text: event.text, at: Date.now() } };

        case 'project.state':
          return { project: event.project };

        case 'auth.state':
          return { auth: event.auth };

        case 'voice.health':
          return { voice: event.health };

        case 'conversation.state':
          return { conversation: event.state };

        case 'conversation.turn':
          return {
            turns: [
              ...state.turns,
              { role: event.role, text: event.text, at: Date.now(), images: event.images },
            ].slice(-40),
          };

        case 'conversation.say':
          return { lastSay: { text: event.text, at: Date.now() } };

        case 'auth.login.line':
          return {
            login: {
              ...state.login,
              running: true,
              // O terminal do popup não precisa de história: 80 linhas bastam.
              lines: [...state.login.lines, event.line].slice(-80),
            },
          };

        case 'auth.login.done':
          return {
            login: { ...state.login, running: false, ok: event.ok, urls: event.urls },
          };

        case 'project.listing':
          return { listing: event.listing };

        case 'project.picked':
          return { pick: { at: Date.now(), path: event.path, error: event.error } };

        case 'error':
          return { lastError: event.message };

        case 'pong':
        default:
          return {};
      }
    }),
}));

/* ---------- seletores derivados ---------- */

export const selectActiveAgentIds = (state: SessionState): string[] =>
  state.agents.filter((agent) => agent.state === 'working').map((agent) => agent.id);

/**
 * Regra pedida: fora de execução a tela mostra TODOS os agentes e skills em brilho pleno.
 * O foco (escurecer o resto) só liga quando existe agente efetivamente trabalhando.
 */
export const selectIsFocusing = (state: SessionState): boolean =>
  state.workflow?.state === 'running' && state.agents.some((agent) => agent.state === 'working');

export const selectAllLinks = (state: SessionState): Link[] =>
  state.links.length > 0 ? state.links : state.previewLinks;
