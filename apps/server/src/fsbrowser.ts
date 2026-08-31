import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';

export interface DirEntry {
  name: string;
  path: string;
  isProject: boolean;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  error?: string;
}

/** Marcadores que denunciam "isto aqui é um projeto". */
const PROJECT_MARKERS = ['.git', 'package.json', '.sln', 'go.mod', 'pyproject.toml', 'Cargo.toml'];

/**
 * Navegador de pastas do lado do servidor.
 *
 * O navegador não entrega caminho real de pasta por segurança — então quem
 * lista o disco é o servidor, que roda na sua máquina e enxerga tudo.
 */
export async function listDirectory(target?: string): Promise<Listing> {
  const path = resolve(target && target.trim() ? target : homedir());
  const root = parse(path).root;
  const parent = path === root ? null : dirname(path);

  try {
    const items = await readdir(path, { withFileTypes: true });
    const dirs = items.filter((item) => item.isDirectory() && !item.name.startsWith('.'));

    const entries = await Promise.all(
      dirs.map(async (item) => {
        const full = join(path, item.name);
        return { name: item.name, path: full, isProject: await looksLikeProject(full) };
      }),
    );

    entries.sort((a, b) => {
      if (a.isProject !== b.isProject) return a.isProject ? -1 : 1;
      return a.name.localeCompare(b.name, 'pt-BR');
    });

    return { path, parent, entries };
  } catch (error) {
    return { path, parent, entries: [], error: (error as Error).message };
  }
}

async function looksLikeProject(path: string): Promise<boolean> {
  const found = await Promise.all(
    PROJECT_MARKERS.map(async (marker) => {
      try {
        await stat(join(path, marker));
        return true;
      } catch {
        return false;
      }
    }),
  );
  return found.some(Boolean);
}

/** Raízes por onde começar: no Windows, as letras de unidade; fora dele, "/". */
export async function listRoots(): Promise<DirEntry[]> {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/', isProject: false }];
  }
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(
    letters.map(async (letter) => {
      const path = `${letter}:\\`;
      try {
        await stat(path);
        return { name: path, path, isProject: false };
      } catch {
        return null;
      }
    }),
  );
  return found.filter((item): item is DirEntry => item !== null);
}

export async function isUsableDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export const projectName = (path: string): string => basename(path) || path;
