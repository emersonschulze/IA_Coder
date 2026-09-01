import type {
  Agent,
  AuthState,
  ConversationState,
  McpState,
  ImageAttachment,
  VoiceHealth,
  AgentState,
  Artifact,
  Listing,
  ProjectState,
  Block,
  Link,
  LogEntry,
  SessionInfo,
  Settings,
  SettingsPatch,
  Skill,
  SubjectDetail,
  SubjectGraph,
  TreeStatus,
  Usage,
  VoiceOption,
  Workflow,
  WorkflowState,
} from './domain';

/** Eventos que o servidor manda para a interface. */
export type ServerEvent =
  | { type: 'session.hello'; session: SessionInfo }
  | { type: 'agents.sync'; agents: Agent[] }
  | { type: 'skills.sync'; skills: Skill[] }
  | {
      type: 'agent.state';
      agentId: string;
      state: AgentState;
      progress?: number;
      skillId?: string | null;
    }
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
  | { type: 'knowledge.saved'; id: string; title: string; created: boolean }
  /**
   * A execução reaproveitou assuntos do Tree.
   *
   * É o que permite a tela oferecer "Atualizar «assunto»" em vez de "Guardar":
   * se esta análise nasceu em cima de um assunto que já existe, gravá-la como
   * novo cria um duplicado — e o que a pessoa quer é reescrever aquele.
   */
  | { type: 'knowledge.reused'; subjects: { id: string; title: string }[] }
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
  | { type: 'mcp.state'; mcp: McpState }
  | { type: 'mcp.login.line'; server: string; line: string }
  | { type: 'mcp.login.done'; server: string; ok: boolean; urls: string[] }
  | { type: 'settings.state'; settings: Settings; dbApplied?: boolean; error?: string }
  | { type: 'voice.options'; options: VoiceOption[]; error?: string }
  | { type: 'pong' }
  | { type: 'error'; message: string };

/** Comandos que a interface manda para o servidor. */
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
  | { type: 'mcp.check' }
  | { type: 'mcp.login'; server: string; mode?: 'shell' | 'window' }
  | { type: 'mcp.dismiss' }
  | { type: 'artifact.open'; path: string; reveal?: boolean }
  | { type: 'tree.list' }
  | { type: 'tree.open'; subjectId: string }
  | { type: 'knowledge.save' }
  | { type: 'knowledge.forget'; subjectId: string }
  /** Descarta a análise atual sem gravar nada — some o convite de guardar. */
  | { type: 'knowledge.discard' }
  /**
   * Grava um assunto ESCRITO POR VOCÊ, sem passar pelo agente.
   *
   * O caminho automático (`knowledge.save`) só existe depois de uma execução
   * terminar, e pede ao agente que resuma a conversa. Uma análise feita só no
   * Talking nunca chegava lá — e era justamente a que valia a pena guardar.
   * Aqui o título e o contexto são seus; nada é inferido.
   */
  | { type: 'knowledge.manual'; title: string; summary: string; tags?: string[] }
  | { type: 'settings.get' }
  | { type: 'settings.save'; patch: SettingsPatch }
  | { type: 'voice.list' }
  | { type: 'ping' };

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Type guard defensivo: nunca confiar cegamente no frame recebido. */
export function isServerEvent(value: unknown): value is ServerEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}
