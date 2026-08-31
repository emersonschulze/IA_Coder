import type { CatalogEntry } from './discovery.js';
import type { Agent, Skill } from './protocol.js';

/**
 * As ferramentas que o Claude Code realmente usa, agrupadas por natureza.
 * Não é enfeite: é o que ele está fazendo naquele segundo — e é isso que
 * acende com o uso e recebe a seta vinda do agente.
 *
 * As skills instaladas (plugin, `.claude` do projeto ou o seu) vêm do disco,
 * pelo `discovery.ts`, e entram na mesma lista depois destas.
 */
export const SKILLS: Skill[] = [
  { id: 'read',   name: 'Leitura',    detail: 'READ · GLOB · GREP',   initials: 'RD', color: '#38bdf8', inUse: false, kind: 'tool' },
  { id: 'edit',   name: 'Edição',     detail: 'EDIT · WRITE',         initials: 'ED', color: '#22d3ee', inUse: false, kind: 'tool' },
  { id: 'shell',  name: 'Shell',      detail: 'BASH · POWERSHELL',    initials: 'SH', color: '#fbbf24', inUse: false, kind: 'tool' },
  { id: 'web',    name: 'Web',        detail: 'SEARCH · FETCH',       initials: 'WB', color: '#a855f7', inUse: false, kind: 'tool' },
  { id: 'task',   name: 'Subagente',  detail: 'TASK · DELEGAÇÃO',     initials: 'TK', color: '#f472b6', inUse: false, kind: 'tool' },
  { id: 'notes',  name: 'Plano',      detail: 'TODO · NOTAS',         initials: 'PL', color: '#34d399', inUse: false, kind: 'tool' },
  { id: 'other',  name: 'Outras',     detail: 'DEMAIS FERRAMENTAS',   initials: 'OT', color: '#94a3b8', inUse: false, kind: 'tool' },
];

const TOOL_TO_SKILL: Record<string, string> = {
  Read: 'read', Glob: 'read', Grep: 'read', NotebookRead: 'read',
  Edit: 'edit', Write: 'edit', NotebookEdit: 'edit', MultiEdit: 'edit',
  Bash: 'shell', BashOutput: 'shell', KillShell: 'shell',
  WebSearch: 'web', WebFetch: 'web',
  Task: 'task', Agent: 'task',
  TodoWrite: 'notes', ExitPlanMode: 'notes',
};

export const skillForTool = (tool: string): string => TOOL_TO_SKILL[tool] ?? 'other';

export const MAIN_AGENT: Agent = {
  id: 'claude',
  name: 'Claude Code',
  role: 'AGENTE PRINCIPAL',
  initials: 'CC',
  color: '#22d3ee',
  state: 'idle',
};

const SUBAGENT_COLORS = ['#a855f7', '#34d399', '#fbbf24', '#f472b6', '#38bdf8'];

export function subAgent(kind: string, index: number): Agent {
  const name = kind.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    id: `sub:${kind}`,
    name,
    role: 'SUBAGENTE · TASK',
    initials: name.slice(0, 2).toUpperCase(),
    color: SUBAGENT_COLORS[index % SUBAGENT_COLORS.length],
    state: 'idle',
  };
}

/* ---------------------------------------------- o que está instalado aqui -- */

/** Cor estável por nome: o mesmo agente tem a mesma cor em toda sessão. */
const PALETTE = ['#22d3ee', '#a855f7', '#34d399', '#fbbf24', '#f472b6', '#38bdf8', '#fb923c', '#c084fc'];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/** "dev-system" → "DS"; "analista" → "AN". Duas letras que você reconhece. */
function initialsFor(name: string): string {
  const parts = name.split(/[-_\s.:]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * Um agente instalado (plugin, `.claude` do projeto ou o seu) vira cartão.
 *
 * Ele nasce ocioso: só acende quando o Claude delega de verdade para ele — o
 * painel mostra quem existe, a execução mostra quem está trabalhando.
 */
export function installedAgent(entry: CatalogEntry): Agent {
  return {
    id: entry.id,
    name: entry.name,
    role: entry.source.toUpperCase(),
    initials: initialsFor(entry.name),
    color: colorFor(entry.name),
    state: 'idle',
    source: entry.source,
  };
}

export function installedSkill(entry: CatalogEntry): Skill {
  return {
    id: entry.id,
    name: entry.name,
    detail: entry.description || entry.source,
    initials: initialsFor(entry.name),
    color: colorFor(entry.name),
    inUse: false,
    source: entry.source,
    kind: 'skill',
  };
}

/**
 * O nome que o Claude usa para chamar não é o nome do arquivo.
 *
 * Ele delega para `JuntoAgents:dev-system:AGENT` e invoca a skill como
 * `JuntoAgents:auditar-cnpj`. Ficamos com o pedaço que identifica de verdade,
 * para casar com o que achamos em disco.
 */
export function bareName(reference: string): string {
  const parts = reference.split(':').filter((part) => part && part !== 'AGENT');
  return (parts.pop() ?? reference).trim().toLowerCase();
}

/** Frase curta para o cabeçalho do bloco, a partir da ferramenta e do argumento. */
export function describeTool(tool: string, input: Record<string, unknown>): string {
  const file = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  const short = file ? file.split(/[\\/]/).slice(-2).join('/') : undefined;
  switch (tool) {
    case 'Read': return `Lendo ${short ?? 'arquivo'}`;
    case 'Edit': case 'MultiEdit': return `Editando ${short ?? 'arquivo'}`;
    case 'Write': return `Escrevendo ${short ?? 'arquivo'}`;
    case 'Glob': return `Procurando ${String(input.pattern ?? '')}`.trim();
    case 'Grep': return `Buscando "${String(input.pattern ?? '')}"`;
    case 'Bash': return `Rodando ${truncate(String(input.command ?? ''), 60)}`;
    case 'WebSearch': return `Pesquisando "${truncate(String(input.query ?? ''), 40)}"`;
    case 'WebFetch': return `Abrindo ${truncate(String(input.url ?? ''), 50)}`;
    case 'Task': return `Delegando para ${bareName(String(input.subagent_type ?? 'subagente'))}`;
    case 'Skill': return `Usando a skill ${bareName(String(input.skill ?? input.name ?? ''))}`.trim();
    case 'TodoWrite': return 'Atualizando o plano';
    default: return tool;
  }
}

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Ferramentas que criam ou alteram arquivo viram artefato no painel Archives. */
export function artifactFromTool(tool: string, input: Record<string, unknown>): { name: string; kind: string; path: string } | null {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return null;
  const path = (input.file_path ?? input.notebook_path) as string | undefined;
  if (!path) return null;
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'code';
  const kind = ['md', 'png', 'jpg', 'pdf', 'pptx', 'xlsx', 'json'].includes(ext) ? ext : 'code';
  return { name, kind, path };
}
