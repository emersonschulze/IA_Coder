import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

export interface Prefs {
  /** Pasta onde o PowerShell e o Claude são abertos. */
  projectPath: string;
  /** Últimos projetos usados, mais recente primeiro. */
  recents: string[];
}

const MAX_RECENTS = 8;

/** Chave de comparação de pasta: no Windows, caixa e barra não distinguem nada. */
const chave = (caminho: string): string =>
  resolve(caminho).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const fallback = (): Prefs => ({ projectPath: resolve(config.defaultProjectPath), recents: [] });

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
        // Também aqui: o arquivo pode ter sido escrito à mão no Bloco de Notas,
        // e `DEFAULT_PROJECT_PATH` vem do ambiente do jeito que a pessoa digitou.
        projectPath: resolve(parsed.projectPath || config.defaultProjectPath),
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
    // Normaliza na porta de entrada, uma vez só.
    //
    // `C:/Repo/X`, `C:\Repo\X` e `c:\repo\x` são a MESMA pasta e todas passam no
    // `stat`, mas o caminho cru viajava até a descoberta de plugins, que compara
    // com o que o Claude Code gravou (sempre com barra invertida): a comparação
    // falhava, o plugin de escopo `project` era descartado em silêncio e os
    // skills dele sumiam do painel. De quebra, o mesmo projeto entrava duas
    // vezes em Recentes, uma por barra escolhida.
    const canonico = resolve(next.projectPath);
    merged.projectPath = canonico;
    merged.recents = [
      canonico,
      ...merged.recents.filter((item) => chave(item) !== chave(canonico)),
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
