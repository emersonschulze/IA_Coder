import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Quem está realmente disponível nesta máquina.
 *
 * O Claude Code não expõe o catálogo por API, mas ele mora em disco num
 * formato estável: `agents/` e `skills/` dentro de cada plugin instalado, do
 * `~/.claude` e do `.claude` do projeto. Lemos de lá — assim o que a tela
 * mostra é o que o agente pode mesmo usar, e não uma lista escrita à mão.
 */
export interface CatalogEntry {
  /** Estável entre varreduras: `agent:<origem>:<nome>`. */
  id: string;
  name: string;
  description: string;
  /** De onde veio: o nome do plugin, "projeto" ou "pessoal". */
  source: string;
  /**
   * A PASTA onde isto mora em disco.
   *
   * Existe por um motivo concreto: alguns agentes de terceiros não invocam a
   * ferramenta `Skill` — o AGENT.md deles manda "antes de usar uma skill, leia
   * o arquivo correspondente" e lista `skills/planejar-e2e/SKILL.md`. Então,
   * nesta máquina, usar uma skill É ler esse arquivo. Sem saber onde cada uma
   * mora, esse uso fica invisível e o painel jura que ninguém usou skill
   * nenhuma.
   */
  dir: string;
}

export interface DiscoveredCatalog {
  agents: CatalogEntry[];
  skills: CatalogEntry[];
}

interface Root {
  dir: string;
  source: string;
}

/** Um `.md` com frontmatter YAML simples — só `name` e `description` importam. */
function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

/** Primeira frase da descrição — o cartão não comporta um parágrafo. */
function summarize(text: string, max = 90): string {
  const clean = text.replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const cut = clean.slice(0, max);
  return clean.length > max ? `${cut.trimEnd()}…` : cut;
}

const listDirs = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
};

const listFiles = async (dir: string, ext: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(ext)).map((entry) => entry.name);
  } catch {
    return [];
  }
};

const read = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

async function entryFrom(
  path: string,
  fallbackName: string,
  kind: 'agent' | 'skill',
  source: string,
  dir = dirname(path),
): Promise<CatalogEntry | null> {
  const raw = await read(path);
  if (raw === null) return null;
  // Os arquivos vêm do Windows: sem normalizar, o CR do fim da linha derruba
  // o frontmatter (o ponto do regex não casa terminador de linha) e toda
  // descrição se perde junto.
  const text = raw.replace(/\r\n?/g, '\n');
  const meta = frontmatter(text);
  const name = meta.name?.trim() || fallbackName;
  // Sem frontmatter — há plugins cujos AGENT.md começam direto no título — a
  // primeira linha de prosa depois dele já diz do que se trata.
  const body = meta.description
    ?? text.split('\n').find((line) => line.trim() && !line.startsWith('#') && !line.startsWith('---'))
    ?? '';
  return { id: `${kind}:${source}:${name}`, name, description: summarize(body), source, dir };
}

/** Prioridade do arquivo dentro da pasta de um agente: menor vem primeiro. */
const rank = (file: string, folder: string): number => {
  const name = file.toLowerCase();
  if (name === 'agent.md') return 0;
  if (name === `${folder.toLowerCase()}.md`) return 1;
  return 2;
};

/**
 * Agentes: ou `agents/<nome>.md`, ou `agents/<nome>/AGENT.md`. Os dois formatos
 * existem no mundo real, então aceitamos os dois.
 */
async function agentsIn(root: Root): Promise<CatalogEntry[]> {
  const dir = join(root.dir, 'agents');
  const found: CatalogEntry[] = [];

  for (const file of await listFiles(dir, '.md')) {
    const entry = await entryFrom(join(dir, file), file.replace(/\.md$/, ''), 'agent', root.source);
    if (entry) found.push(entry);
  }
  for (const folder of await listDirs(dir)) {
    // Um agente por pasta. Quando há mais de um `.md`, o que define o agente é
    // o AGENT.md (ou um arquivo com o nome da pasta) — o resto é anexo.
    const files = (await listFiles(join(dir, folder), '.md')).sort((a, b) =>
      rank(a, folder) - rank(b, folder) || a.localeCompare(b));
    for (const file of files) {
      const entry = await entryFrom(join(dir, folder, file), folder, 'agent', root.source);
      if (entry) {
        found.push(entry);
        break;
      }
    }
  }
  return found;
}

/** Skills: `skills/<nome>/SKILL.md`, com um nível opcional de agrupamento. */
async function skillsIn(root: Root, folder = 'skills', depth = 2): Promise<CatalogEntry[]> {
  const dir = join(root.dir, folder);
  const found: CatalogEntry[] = [];
  for (const name of await listDirs(dir)) {
    const entry = await entryFrom(join(dir, name, 'SKILL.md'), name, 'skill', root.source);
    if (entry) {
      found.push(entry);
      continue;
    }
    if (depth > 1) found.push(...(await skillsIn(root, join(folder, name), depth - 1)));
  }
  return found;
}

/** Plugins instalados, do arquivo que o próprio Claude Code mantém. */
async function pluginRoots(projectPath: string): Promise<Root[]> {
  const raw = await read(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'));
  if (!raw) return [];
  let parsed: { plugins?: Record<string, { scope?: string; projectPath?: string; installPath?: string }[]> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const wanted = projectPath.replace(/[\\/]+$/, '').toLowerCase();
  const roots: Root[] = [];
  for (const [key, installs] of Object.entries(parsed.plugins ?? {})) {
    const name = key.split('@')[0];
    for (const install of installs ?? []) {
      if (!install.installPath) continue;
      // Plugin de escopo "project" só vale dentro do projeto onde foi instalado.
      const scoped = install.scope === 'project';
      if (scoped && install.projectPath?.replace(/[\\/]+$/, '').toLowerCase() !== wanted) continue;
      roots.push({ dir: install.installPath, source: name });
      break; // o mesmo plugin aparece uma vez por escopo
    }
  }
  return roots;
}

/**
 * Varre tudo e devolve o catálogo, sem repetição.
 *
 * A ordem das origens decide quem ganha em caso de nome repetido: o projeto
 * manda mais que o pessoal, que manda mais que o plugin — a mesma precedência
 * que o Claude Code usa.
 */
export async function discoverCatalog(projectPath: string): Promise<DiscoveredCatalog> {
  const roots: Root[] = [
    { dir: join(projectPath, '.claude'), source: 'projeto' },
    { dir: join(homedir(), '.claude'), source: 'pessoal' },
    ...(await pluginRoots(projectPath)),
  ];

  const agents = new Map<string, CatalogEntry>();
  const skills = new Map<string, CatalogEntry>();

  for (const root of roots) {
    const [foundAgents, foundSkills] = await Promise.all([agentsIn(root), skillsIn(root)]);
    foundAgents.forEach((entry) => {
      if (!agents.has(entry.name)) agents.set(entry.name, entry);
    });
    foundSkills.forEach((entry) => {
      if (!skills.has(entry.name)) skills.set(entry.name, entry);
    });
  }

  const byName = (a: CatalogEntry, b: CatalogEntry): number => a.name.localeCompare(b.name, 'pt-BR');
  return {
    agents: [...agents.values()].sort(byName),
    skills: [...skills.values()].sort(byName),
  };
}
