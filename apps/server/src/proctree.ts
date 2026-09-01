import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Mata um processo E TUDO que ele abriu.
 *
 * `child.kill()` do Node mata UM processo, e no Windows isso quase nunca é o
 * que você quer aqui. Duas razões, as duas presentes nesta ferramenta:
 *
 * - O `claude` é um `.cmd`, então ele sobe por `cmd.exe /c claude …`. O que o
 *   `kill()` alcança é o `cmd.exe`; o processo do Claude continua vivo, órfão,
 *   com os subagentes dele e qualquer `bash` que tenham aberto. Era exatamente
 *   isto que fazia o ABORTAR limpar a tela sem parar o trabalho: a tela
 *   encerrava, a máquina continuava trabalhando.
 * - O PowerShell no meio de um `dotnet build` morre, mas o `dotnet` não: ele
 *   fica rodando, segurando arquivo e queimando CPU sem ninguém olhando.
 *
 * `taskkill /T` desce a árvore inteira, e `/F` não pede licença — abortar é
 * pedido explícito de parar agora. Fora do Windows, matar o GRUPO do processo
 * tem o mesmo efeito.
 */
export function killTree(child: ChildProcess | null): void {
  const pid = child?.pid;
  if (!child || !pid) return;

  if (process.platform !== 'win32') {
    try {
      // O sinal negativo é o grupo. Se o processo não é líder de grupo, o
      // fallback abaixo ainda mata ele sozinho.
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      child.kill('SIGKILL');
      return;
    }
  }

  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    });
  } catch {
    /* taskkill não estar disponível é improvável; o kill abaixo é a rede. */
  }
  // Rede de segurança: se o taskkill falhou (processo já morto, permissão), o
  // kill normal ainda encerra o que dá.
  try {
    child.kill();
  } catch {
    /* já morreu */
  }
}
