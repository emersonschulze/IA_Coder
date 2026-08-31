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
  { id: 'notes',  name: 'Plano',      detail: 'TODO · NOTAS',         initials: 'PL', color: '#34d399', inUse: false, kind: 'tool' },
  { id: 'other',  name: 'Outras',     detail: 'DEMAIS FERRAMENTAS',   initials: 'OT', color: '#94a3b8', inUse: false, kind: 'tool' },
];

/**
 * Os nomes que a ferramenta de delegação já teve.
 *
 * Este Claude Code chama de `Agent`; versões anteriores chamavam de `Task`.
 * Reconhecer só um dos dois é o bastante para o subagente nunca aparecer na
 * tela: a delegação passa batida e todo o trabalho dele fica creditado ao
 * agente principal.
 */
export const DELEGATION_TOOLS = new Set(['Agent', 'Task']);

export const isDelegation = (tool: string): boolean => DELEGATION_TOOLS.has(tool);

const TOOL_TO_SKILL: Record<string, string> = {
  Read: 'read', Glob: 'read', Grep: 'read', NotebookRead: 'read',
  Edit: 'edit', Write: 'edit', NotebookEdit: 'edit', MultiEdit: 'edit',
  Bash: 'shell', BashOutput: 'shell', KillShell: 'shell',
  WebSearch: 'web', WebFetch: 'web',
  Task: 'task', Agent: 'task',
  TodoWrite: 'notes', ExitPlanMode: 'notes',
};

export const skillForTool = (tool: string): string => TOOL_TO_SKILL[tool] ?? 'other';

/**
 * Qual CARTÃO do painel Skill esta ferramenta acende — se é que acende algum.
 *
 * Delegar não é uma habilidade. `Task` responde "quem faz", não "o que está
 * sendo feito", e isso a tela já conta melhor em outro lugar: o bloco do
 * principal diz por quem ele espera e cada subagente ganha o cartão dele. Como
 * cartão de skill, "Subagente" só fazia barulho — acendia em toda delegação e
 * era o único aceso enquanto quatro especialistas trabalhavam, escondendo
 * justamente o que cada um deles estava fazendo.
 *
 * `skillForTool` continua devolvendo `task`: a narração falada usa esse grupo
 * para dizer "o subagente está nisso", e ali a informação é útil.
 */
export const skillCardForTool = (tool: string): string | null => {
  const group = skillForTool(tool);
  return group === 'task' ? null : group;
};

/**
 * A skill que este caminho representa, se ele estiver dentro da pasta de alguma.
 *
 * @param dirs pasta em disco (minúscula, separador normalizado) → id da skill
 */
export function skillFromPath(path: string, dirs: Map<string, string>): string | null {
  const alvo = normalizeDir(path);
  for (const [dir, id] of dirs) {
    if (alvo === dir || alvo.startsWith(`${dir}/`)) return id;
  }
  return null;
}

/**
 * `skills/<pasta>/SKILL.md` dentro de um texto qualquer — caminho ou comando.
 *
 * Duas coisas que o casamento por caminho absoluto não resolve, e as duas
 * aconteceram na prática:
 *
 * 1. **A mesma skill mora em dois lugares.** A descoberta indexa o cache do
 *    plugin (`~/.claude/plugins/cache/junto-agents/…/skills/planejar-e2e`), mas
 *    o agente abre o repo-fonte (`C:/Repositorio/JuntoAgents/skills/planejar-e2e`)
 *    — é a mesma skill em duas cópias, e comparar caminho absoluto nunca casa.
 * 2. **Nem toda leitura passa pela ferramenta `Read`.** O agente faz
 *    `cat ".../SKILL.md"` pelo Bash, e aí o que existe é uma linha de comando,
 *    não um `file_path`.
 *
 * Exigir o `SKILL.md` no fim é o que segura o falso positivo: `ls skills/` ou um
 * grep que só cita o nome da skill não casam. Referenciar aquele arquivo é
 * referenciar a skill.
 */
export function skillFromText(text: string, byFolder: Map<string, string>): string | null {
  if (!text) return null;
  const pattern = /skills[/\\]([^/\\\s"']+)[/\\]skill\.md/gi;
  for (const match of text.toLowerCase().matchAll(pattern)) {
    const found = byFolder.get(match[1]);
    if (found) return found;
  }
  return null;
}

/** A última pasta de um caminho: `.../skills/planejar-e2e` → `planejar-e2e`. */
export const folderOf = (dir: string): string =>
  normalizeDir(dir).split('/').filter(Boolean).pop() ?? '';

/** Mesma normalização dos dois lados da comparação, senão nada casa no Windows. */
export const normalizeDir = (dir: string): string =>
  dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

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

/** Cor estável por nome: a mesma skill tem a mesma cor em toda sessão. */
const PALETTE = ['#22d3ee', '#a855f7', '#34d399', '#fbbf24', '#f472b6', '#38bdf8', '#fb923c', '#c084fc'];

/**
 * Cores dos agentes instalados.
 *
 * O ciano fica de fora: é do agente principal, e dois cartões da mesma cor
 * tornam impossível dizer de quem é a seta quando eles trabalham em paralelo.
 * E a distribuição é por ÍNDICE, não por hash do nome: hash colide à toa — era
 * o que fazia "arquiteto" nascer idêntico ao "Claude Code".
 */
const AGENT_PALETTE = ['#a855f7', '#34d399', '#fbbf24', '#f472b6', '#fb923c', '#c084fc', '#60a5fa', '#f87171'];

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
export function installedAgent(entry: CatalogEntry, index = 0): Agent {
  return {
    id: entry.id,
    name: entry.name,
    role: entry.source.toUpperCase(),
    initials: initialsFor(entry.name),
    color: AGENT_PALETTE[index % AGENT_PALETTE.length],
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
    case 'Task':
    case 'Agent': return `Delegando para ${bareName(String(input.subagent_type ?? 'subagente'))}`;
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
