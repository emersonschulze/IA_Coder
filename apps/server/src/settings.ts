import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, databaseParts, redisParts, voiceParts } from './config.js';
import type { DatabaseSettings, RedisSettings, Settings, SettingsPatch, VoiceSettings } from './protocol.js';

/**
 * Configuração editável pela tela de Configurações — banco, Redis e voz.
 *
 * Vive em `workspace/settings.json`, separado do `.env`: o `.env` é para quem
 * sobe os containers (`docker compose up -d`), isto aqui é para onde o
 * SERVIDOR aponta. Os dois costumam bater, mas não precisam — dá para o banco
 * estar em outra máquina, por exemplo. Sem o arquivo, cai nos mesmos valores
 * que o `.env` sempre deu.
 */
function defaults(): Settings {
  return {
    database: { ...databaseParts },
    redis: { ...redisParts },
    voice: { ...voiceParts },
  };
}

function load(): Settings {
  const base = defaults();
  if (!existsSync(config.settingsFile)) return base;
  try {
    const raw = JSON.parse(readFileSync(config.settingsFile, 'utf8')) as Partial<Settings>;
    return {
      database: { ...base.database, ...raw.database },
      redis: { ...base.redis, ...raw.redis },
      voice: { ...base.voice, ...raw.voice },
    };
  } catch (error) {
    console.warn(`[settings] ${config.settingsFile} corrompido, usando padrão: ${(error as Error).message}`);
    return base;
  }
}

let current: Settings = load();

export const getSettings = (): Settings => current;

function merge<T extends object>(base: T, patch: Partial<T> | undefined): T {
  return patch ? { ...base, ...patch } : base;
}

/** Grava o patch e devolve a configuração completa já mesclada. */
export function saveSettings(patch: SettingsPatch): Settings {
  current = {
    database: merge(current.database, patch.database),
    redis: merge(current.redis, patch.redis),
    voice: merge(current.voice, patch.voice),
  };
  mkdirSync(dirname(config.settingsFile), { recursive: true });
  writeFileSync(config.settingsFile, JSON.stringify(current, null, 2));
  return current;
}

/** Esconde a senha antes de logar — nunca no `console.log` em texto puro. */
const mask = (value: string): string => (value ? '•'.repeat(Math.min(8, value.length)) : '');

export function databaseUrl(s: DatabaseSettings = current.database): string {
  const credentials = `${encodeURIComponent(s.user)}:${encodeURIComponent(s.password)}`;
  return `postgresql://${credentials}@${s.host}:${s.port}/${s.name}`;
}

export function redisUrl(s: RedisSettings = current.redis): string {
  const auth = s.password ? `:${encodeURIComponent(s.password)}@` : '';
  return `redis://${auth}${s.host}:${s.port}`;
}

/** Só para log — nunca a senha. */
export function describeDatabase(s: DatabaseSettings = current.database): string {
  return `postgresql://${s.user}:${mask(s.password)}@${s.host}:${s.port}/${s.name}`;
}

export type { DatabaseSettings, RedisSettings, Settings, SettingsPatch, VoiceSettings };
