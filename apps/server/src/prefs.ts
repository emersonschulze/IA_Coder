import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export interface Prefs {
  /** Pasta onde o PowerShell e o Claude são abertos. */
  projectPath: string;
  /** Últimos projetos usados, mais recente primeiro. */
  recents: string[];
}

const MAX_RECENTS = 8;

const fallback = (): Prefs => ({ projectPath: config.defaultProjectPath, recents: [] });

let cache: Prefs | null = null;

/**
 * Preferências em JSON simples, dentro de workspace/. Deliberadamente fora do
 * Postgres: o caminho do projeto precisa existir antes de qualquer container
 * subir, e você deve conseguir corrigir no Bloco de Notas se digitar errado.
 */
export function readPrefs(): Prefs {
  if (cache) return cache;
  try {
    if (existsSync(config.prefsFile)) {
      const parsed = JSON.parse(readFileSync(config.prefsFile, 'utf8')) as Partial<Prefs>;
      cache = {
        projectPath: parsed.projectPath || config.defaultProjectPath,
        recents: Array.isArray(parsed.recents) ? parsed.recents.slice(0, MAX_RECENTS) : [],
      };
      return cache;
    }
  } catch (error) {
    console.warn('[prefs] arquivo ilegível, usando os padrões:', error);
  }
  cache = fallback();
  return cache;
}

export function writePrefs(next: Partial<Prefs>): Prefs {
  const merged: Prefs = { ...readPrefs(), ...next };
  if (next.projectPath) {
    merged.recents = [
      next.projectPath,
      ...merged.recents.filter((item) => item !== next.projectPath),
    ].slice(0, MAX_RECENTS);
  }
  cache = merged;
  try {
    mkdirSync(dirname(config.prefsFile), { recursive: true });
    writeFileSync(config.prefsFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('[prefs] não consegui gravar:', error);
  }
  return merged;
}
