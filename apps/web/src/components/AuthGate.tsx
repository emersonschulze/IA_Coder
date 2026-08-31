import { useEffect, useRef } from 'react';
import { useSession } from '@/store/useSession';
import styles from './AuthGate.module.css';

interface Props {
  /** Faz o login pelo PowerShell que já está aberto na pasta do projeto. */
  onLogin: () => void;
  /** Abre uma janela de terminal visível, quando o caminho de cima não serve. */
  onLoginWindow: () => void;
  onRecheck: () => void;
}

/**
 * Convite para entrar de novo quando a credencial do Claude Code expira.
 *
 * Em modo não interativo não existe tela de login — o turno só falha com um
 * 401. Como já mantemos um PowerShell aberto na pasta do projeto, o login
 * acontece por ele: a saída do `claude auth login` vem para cá em tempo real e
 * o endereço de autorização aparece clicável, sem abrir janela nenhuma.
 */
export function AuthGate({ onLogin, onLoginWindow, onRecheck }: Props) {
  const auth = useSession((state) => state.auth);
  const login = useSession((state) => state.login);
  const console_ = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = console_.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [login.lines.length]);

  if (!auth || auth.loggedIn) return null;

  const expired = auth.reason === 'expired';
  const started = login.lines.length > 0 || login.running;

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog} role="alertdialog" aria-label="Login do Claude">
        <header className={styles.head}>
          <span className={styles.badge}>{expired ? 'Sessão expirada' : 'Sem credencial'}</span>
          <h2>
            {expired
              ? 'O token do Claude venceu — precisa entrar de novo'
              : 'O Claude Code ainda não está autenticado'}
          </h2>
        </header>

        <p className={styles.body}>
          O login roda no <b>PowerShell que já está aberto na pasta do projeto</b>. Clique abaixo:
          o endereço de autorização aparece aqui e no seu navegador. Depois de aprovar, o agente
          reinicia sozinho com a credencial nova.
        </p>

        {started && (
          <>
            <div className={styles.console} ref={console_}>
              {login.lines.map((line, index) => (
                <div key={`${index}-${line.slice(0, 12)}`}>{line}</div>
              ))}
              {login.running && <div className={styles.blink}>aguardando você aprovar…</div>}
            </div>

            {login.urls.length > 0 && (
              <div className={styles.links}>
                {login.urls.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer">
                    ↗ {url}
                  </a>
                ))}
              </div>
            )}
          </>
        )}

        {auth.error && <p className={styles.error}>{auth.error}</p>}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={onLogin}
            disabled={login.running}
          >
            {login.running ? '⏳ entrando…' : '⌸ Entrar pelo PowerShell'}
          </button>
          <button type="button" className={styles.ghost} onClick={onRecheck}>
            ✓ Já entrei
          </button>
        </div>

        <p className={styles.footnote}>
          Travou? <button type="button" className={styles.linkish} onClick={onLoginWindow}>
            abrir numa janela do PowerShell
          </button>{' '}
          — ou rode <code>claude auth login</code> em qualquer terminal e clique em “Já entrei”.
        </p>
      </div>
    </div>
  );
}
