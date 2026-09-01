import { useEffect, useRef, useState } from 'react';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { useSession } from '@/store/useSession';
import styles from './ProjectPicker.module.css';

interface Props {
  onBrowse: (path?: string) => void;
  /** Abre o seletor de pastas do Windows. */
  onPickNative: () => void;
  onConfirm: (path: string) => void;
  onClose: () => void;
}

/** Tempo até assumirmos que o servidor não vai responder. */
const NO_ANSWER_MS = 4000;

/**
 * Escolha da pasta do projeto.
 *
 * O caminho principal é o Explorer do Windows — quem abre é o servidor, que
 * roda na sua máquina; o navegador não entrega caminho real de pasta. A lista
 * interna fica como alternativa para quando o diálogo nativo não aparecer.
 */
export function ProjectPicker({ onBrowse, onPickNative, onConfirm, onClose }: Props) {
  const listing = useSession((state) => state.listing);
  const project = useSession((state) => state.project);
  const pick = useSession((state) => state.pick);
  const session = useSession((state) => state.session);
  const connection = useSession((state) => state.connection);

  const [typed, setTyped] = useState(project?.path ?? '');
  const [waiting, setWaiting] = useState(false);
  const [silent, setSilent] = useState(false);
  const [slowPick, setSlowPick] = useState(false);
  const askedAt = useRef(0);
  const pathInput = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(true, pathInput);

  /**
   * De quem é a culpa, de verdade.
   *
   * Antes eu chutava "deve ser o mock". Agora o servidor se apresenta dizendo
   * versão e o que sabe fazer, então dá para separar três situações que na tela
   * pareciam idênticas: não tem ninguém do outro lado, tem alguém que não é o
   * nosso servidor, ou é o nosso mas de uma versão anterior.
   */
  const diagnosis: 'ok' | 'offline' | 'stranger' | 'outdated' = (() => {
    if (connection !== 'open') return 'offline';
    if (!session) return 'stranger';
    if (!session.features?.includes('picker')) return 'outdated';
    return 'ok';
  })();

  useEffect(() => {
    onBrowse(project?.path);
    const timer = window.setTimeout(() => setSilent(true), NO_ANSWER_MS);
    return () => window.clearTimeout(timer);
    // Só na abertura: começamos na pasta que já está em uso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (listing) setSilent(false);
    if (listing?.path) setTyped(listing.path);
  }, [listing]);

  // O diálogo nativo fica aberto até a pessoa responder — o botão espera junto.
  useEffect(() => {
    if (pick && pick.at > askedAt.current) {
      setWaiting(false);
      setSlowPick(false);
    }
  }, [pick]);

  // Esperar é normal (a janela fica aberta o tempo que você quiser), mas ficar
  // esperando para sempre não é. Depois de 12s oferecemos uma saída.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setSlowPick(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  /*
   * Só o Escape é global.
   *
   * O Enter ficava aqui também, e as linhas da listagem são `<button>`: o Enter
   * que entrava numa pasta subia até `window` e confirmava JUNTO — com o
   * `typed`, que o efeito acima acabara de sobrescrever com a pasta ATUAL. Dava
   * `onBrowse(subpasta)` e `onConfirm(pasta pai)` de uma vez: o diálogo
   * fechava, o servidor reabria o PowerShell e o Claude no diretório errado, e
   * navegar a lista pelo teclado era impossível. Agora o Enter mora no campo de
   * texto, que é de quem ele é.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openExplorer = (): void => {
    askedAt.current = Date.now();
    setWaiting(true);
    onPickNative();
  };

  /** Nada de "carregando" eterno. */
  const noAnswer = diagnosis !== 'ok' || (silent && !listing);

  return (
    <div
      className={styles.overlay}
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Escolher pasta do projeto"
      >
        <header className={styles.head}>
          <h2>Pasta do projeto</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>

        <div className={styles.pathbar}>
          <button
            type="button"
            className={styles.explorer}
            onClick={openExplorer}
            disabled={waiting || diagnosis !== 'ok'}
            title={diagnosis === 'ok' ? 'Abre o seletor de pastas do Windows' : 'Precisa do servidor de pé'}
          >
            {waiting ? '⏳ escolha a pasta na janela do Windows…' : '📁 Abrir o Explorer'}
          </button>
        </div>

        {slowPick && waiting && (
          <p className={styles.hint}>
            A janela do Windows pode ter aberto atrás do navegador — procure na barra de tarefas.{' '}
            <button type="button" className={styles.linkish} onClick={() => setWaiting(false)}>
              desistir da espera
            </button>
          </p>
        )}

        {pick?.error && (
          <p className={styles.error}>
            O seletor do Windows não abriu: {pick.error}. Use a lista abaixo ou digite o caminho.
          </p>
        )}
        {pick && !pick.error && pick.path === null && !waiting && (
          <p className={styles.hint}>Você fechou a janela sem escolher.</p>
        )}

        {noAnswer ? (
          <div className={styles.diagnose}>
            {diagnosis === 'offline' && (
              <>
                <strong>Sem conexão com o servidor.</strong>
                <span>
                  A interface não conseguiu abrir o WebSocket. O servidor provavelmente não subiu —
                  ou caiu logo depois. <b>Olhe o terminal do <code>apps\server</code>:</b> se ele
                  fechou com erro, a mensagem está lá.
                </span>
              </>
            )}
            {diagnosis === 'stranger' && (
              <>
                <strong>Tem alguém na porta, mas não é o nosso servidor.</strong>
                <span>
                  A conexão abriu e ninguém se apresentou. Isso acontece quando outro processo
                  ocupou a porta 8787 — o <code>npm run mock</code>, por exemplo, ou uma instância
                  antiga que ficou pendurada.
                </span>
              </>
            )}
            {diagnosis === 'outdated' && (
              <>
                <strong>O servidor conectado é de uma versão anterior.</strong>
                <span>
                  Ele se apresentou como <code>{session?.version ?? 'sem versão'}</code> e não
                  conhece o comando de abrir pastas. O processo precisa ser reiniciado depois da
                  atualização — e <code>npm install</code> antes, porque entraram dependências
                  novas (<code>pg</code>).
                </span>
              </>
            )}
            {diagnosis === 'ok' && (
              <>
                <strong>O servidor não respondeu a tempo.</strong>
                <span>
                  Ele está conectado e na versão certa, mas a listagem de pastas não voltou. O erro
                  deve estar no terminal do <code>apps\server</code>.
                </span>
              </>
            )}

            <code className={styles.cmd}>
              {'cd apps\\server\nnpm install\nnpm run dev'}
            </code>

            <span className={styles.state}>
              conexão: {connection} · servidor:{' '}
              {session ? `${session.runtime} ${session.version ?? '(sem versão)'}` : 'não se apresentou'}
              {session?.features && ` · sabe: ${session.features.join(', ')}`}
            </span>

            <span>Enquanto isso, dá para digitar o caminho no campo abaixo e apertar Enter.</span>
          </div>
        ) : (
          <div className={styles.list}>
            {project && project.recents.length > 0 && (
              <>
                <div className={styles.section}>Recentes</div>
                {project.recents.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className={styles.row}
                    onClick={() => onConfirm(path)}
                  >
                    <span className={styles.icon}>★</span>
                    <span>{path}</span>
                  </button>
                ))}
                <div className={styles.section}>Pastas</div>
              </>
            )}

            {listing?.parent && (
              <button
                type="button"
                className={styles.row}
                onClick={() => onBrowse(listing.parent ?? undefined)}
              >
                <span className={styles.icon}>↑</span>
                <span>.. voltar uma pasta</span>
              </button>
            )}

            {(listing?.entries ?? []).map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={styles.row}
                onClick={() => onBrowse(entry.path)}
                onDoubleClick={() => onConfirm(entry.path)}
                title="Um clique abre · dois cliques escolhem"
              >
                <span className={styles.icon}>{entry.isProject ? '◈' : '▸'}</span>
                <span>{entry.name}</span>
                {entry.isProject && <span className={styles.badgeProject}>projeto</span>}
              </button>
            ))}

            {listing?.error && <p className={styles.error}>{listing.error}</p>}
            {!listing && <p className={styles.hint}>carregando as pastas…</p>}
            {listing && listing.entries.length === 0 && !listing.error && (
              <div className={styles.section}>nenhuma subpasta aqui</div>
            )}
          </div>
        )}

        <footer className={styles.foot}>
          <input
            ref={pathInput}
            className={styles.pathInput}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (typed.trim()) onConfirm(typed.trim());
            }}
            placeholder="ou digite o caminho e aperte Enter"
            spellCheck={false}
          />
          <button
            type="button"
            className={styles.confirm}
            onClick={() => typed.trim() && onConfirm(typed.trim())}
          >
            Usar esta pasta
          </button>
        </footer>
      </div>
    </div>
  );
}
