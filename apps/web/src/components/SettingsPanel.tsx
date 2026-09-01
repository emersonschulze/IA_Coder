import { useEffect, useState } from 'react';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { useSession } from '@/store/useSession';
import type { DatabaseSettings, RedisSettings, SettingsPatch } from '@/types/domain';
import styles from './SettingsPanel.module.css';

interface Props {
  onSave: (patch: SettingsPatch) => void;
  onListVoices: () => void;
  onClose: () => void;
}

const numeric = (value: string, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Onde o servidor busca banco, Redis e voz.
 *
 * Não sobe container nenhum — quem faz isso é `docker compose up -d`. Isto
 * aqui só diz ao processo Node onde bater, e por isso banco e voz aplicam na
 * hora: banco reconecta de verdade (o servidor derruba o pool velho e sobe
 * um novo), voz já vale no próximo áudio. Redis só grava por enquanto — o
 * servidor ainda não usa.
 */
export function SettingsPanel({ onSave, onListVoices, onClose }: Props) {
  const settings = useSession((state) => state.settings);
  const dbApplied = useSession((state) => state.settingsDbApplied);
  const voiceOptions = useSession((state) => state.voiceOptions);
  const dialogRef = useDialogFocus<HTMLDivElement>(Boolean(settings));

  const [database, setDatabase] = useState<DatabaseSettings | null>(null);
  const [redis, setRedis] = useState<RedisSettings | null>(null);
  const [wakeWord, setWakeWord] = useState('');
  const [saving, setSaving] = useState(false);

  // A tela chega vazia (settings ainda não respondeu) e se preenche sozinha —
  // só na primeira vez que os dados aparecem, para não sobrescrever o que a
  // pessoa está digitando quando um evento novo chegar no meio da edição.
  useEffect(() => {
    if (settings && !database) setDatabase(settings.database);
    if (settings && !redis) setRedis(settings.redis);
    if (settings && !wakeWord) setWakeWord(settings.voice.wakeWord);
  }, [settings, database, redis, wakeWord]);

  useEffect(() => {
    onListVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [onClose]);

  // Some sozinho assim que a resposta de uma tentativa chega — não trava a
  // tela num "salvando…" para sempre se o servidor demorar a responder.
  useEffect(() => {
    if (dbApplied !== null) setSaving(false);
  }, [dbApplied]);

  if (!settings || !database || !redis) return null;

  const selectVoice = (id: string): void => onSave({ voice: { piperVoice: id } });

  const saveInfra = (): void => {
    setSaving(true);
    onSave({ database, redis, voice: { wakeWord } });
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <span className={styles.badge}>Configurações</span>
            <h2>Banco, Redis e voz</h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose} title="Fechar (Esc)">
            ✕
          </button>
        </header>

        <p className={styles.body}>
          Isto diz ao servidor <b>onde bater</b> — não sobe nada. Quem sobe Postgres, Redis,
          Whisper e Piper continua sendo <code>docker compose up -d</code>.
        </p>

        <div className={styles.scroll}>
          <section className={styles.section}>
            <h3>Banco de dados (Postgres + pgvector)</h3>
            <div className={styles.grid}>
              <label className={styles.field}>
                <span>Host</span>
                <input
                  value={database.host}
                  onChange={(event) => setDatabase({ ...database, host: event.target.value })}
                />
              </label>
              <label className={styles.field}>
                <span>Porta</span>
                <input
                  value={database.port}
                  inputMode="numeric"
                  onChange={(event) =>
                    setDatabase({ ...database, port: numeric(event.target.value, database.port) })
                  }
                />
              </label>
              <label className={styles.field}>
                <span>Usuário</span>
                <input
                  value={database.user}
                  onChange={(event) => setDatabase({ ...database, user: event.target.value })}
                />
              </label>
              <label className={styles.field}>
                <span>Senha</span>
                <input
                  type="password"
                  value={database.password}
                  onChange={(event) => setDatabase({ ...database, password: event.target.value })}
                />
              </label>
              <label className={[styles.field, styles.fieldWide].join(' ')}>
                <span>Nome do banco</span>
                <input
                  value={database.name}
                  onChange={(event) => setDatabase({ ...database, name: event.target.value })}
                />
              </label>
            </div>
          </section>

          <section className={styles.section}>
            <h3>Redis</h3>
            <p className={styles.hint}>
              Guardado, mas ainda sem uso pelo servidor — entra quando houver mais de um agente em
              paralelo (fila e pub/sub).
            </p>
            <div className={styles.grid}>
              <label className={styles.field}>
                <span>Host</span>
                <input
                  value={redis.host}
                  onChange={(event) => setRedis({ ...redis, host: event.target.value })}
                />
              </label>
              <label className={styles.field}>
                <span>Porta</span>
                <input
                  value={redis.port}
                  inputMode="numeric"
                  onChange={(event) => setRedis({ ...redis, port: numeric(event.target.value, redis.port) })}
                />
              </label>
              <label className={[styles.field, styles.fieldWide].join(' ')}>
                <span>Senha (opcional)</span>
                <input
                  type="password"
                  value={redis.password}
                  onChange={(event) => setRedis({ ...redis, password: event.target.value })}
                />
              </label>
            </div>
          </section>

          {dbApplied === false && (
            <p className={styles.error}>
              Não consegui conectar nesse endereço. Confira host/porta/usuário/senha — o Tree
              continua tentando sozinho a cada 10s se você deixar assim mesmo.
            </p>
          )}
          {dbApplied === true && <p className={styles.ok}>Conectado.</p>}

          <section className={styles.section}>
            <h3>Voz</h3>
            <p className={styles.hint}>
              Whisper (ouvir) e Piper (falar) são os endereços do <code>docker compose --profile
              voice up -d</code>; só mude se rodar em outra máquina. A voz troca na hora — sem
              reiniciar nada.
            </p>
            <label className={styles.field}>
              <span>Palavra de ativação</span>
              <input value={wakeWord} onChange={(event) => setWakeWord(event.target.value)} />
            </label>

            <div className={styles.voices}>
              {voiceOptions.length === 0 && (
                <p className={styles.hint}>
                  Piper fora do ar — sem ele não dá para listar nem trocar de voz agora.
                </p>
              )}
              {voiceOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={[
                    styles.voice,
                    option.id === settings.voice.piperVoice ? styles.voiceActive : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => selectVoice(option.id)}
                  title={option.installed ? 'já baixada' : 'baixa na primeira fala'}
                >
                  {option.id === settings.voice.piperVoice ? '● ' : '○ '}
                  {option.label}
                  {!option.installed && <span className={styles.download}> ↓</span>}
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={saveInfra} disabled={saving}>
            {saving ? '⏳ aplicando…' : '💾 Salvar banco e Redis'}
          </button>
          <button type="button" className={styles.ghost} onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
