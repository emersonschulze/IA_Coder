import { useEffect, useRef, useState } from 'react';
import styles from './SubjectDialog.module.css';

interface Props {
  /** Texto que já veio junto do comando — vira o nome sugerido. */
  initialTitle?: string;
  onSave: (title: string, summary: string, tags: string[]) => void;
  onClose: () => void;
}

/**
 * Guardar um assunto no Tree escrito por você.
 *
 * O caminho automático depende de duas coisas acontecerem: uma execução ter
 * terminado, e o agente conseguir resumir a conversa em JSON. Análise feita só
 * no Talking não passa pela primeira — e era justamente a que valia guardar:
 * você conversou, entendeu o serviço, e não tinha onde registrar.
 *
 * Aqui não há inferência nenhuma. O nome do nó e o contexto são seus, vão para
 * o banco do jeito que você escreveu, e funcionam mesmo com o agente fora do ar.
 */
export function SubjectDialog({ initialTitle = '', onSave, onClose }: Props) {
  const [title, setTitle] = useState(initialTitle);
  const [summary, setSummary] = useState('');
  const [tags, setTags] = useState('');
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => first.current?.focus(), []);

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [onClose]);

  const ready = title.trim().length > 0 && summary.trim().length > 0;
  const submit = (): void => {
    if (!ready) return;
    onSave(
      title.trim(),
      summary.trim(),
      tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    );
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className={styles.dialog}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header className={styles.head}>
          <div>
            <span className={styles.badge}>Tree · assunto novo</span>
            <h2>Guardar no Tree</h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose} title="Fechar (Esc)">
            ✕
          </button>
        </header>

        <p className={styles.body}>
          Da próxima vez que alguém pedir algo parecido, isto entra como contexto pronto e o
          agente começa sabendo — em vez de investigar tudo de novo.
        </p>

        <label className={styles.field}>
          <span>Nome do nó</span>
          <input
            ref={first}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="ex.: Identidade e SSO (ms-auth + Keycloak)"
            maxLength={120}
          />
        </label>

        <label className={styles.field}>
          <span>Contexto</span>
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder={'O que foi aprendido e as decisões tomadas.\nQuanto mais concreto, mais útil ele volta depois.'}
            rows={7}
          />
        </label>

        <label className={styles.field}>
          <span>
            Tags <small>opcional, separadas por vírgula</small>
          </span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="auth, sso, keycloak"
            maxLength={160}
          />
        </label>

        <p className={styles.footnote}>
          Um assunto com o mesmo nome é <b>reescrito</b>, não duplicado.
        </p>

        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={!ready}>
            ✓ Guardar
          </button>
          <button type="button" className={styles.ghost} onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
