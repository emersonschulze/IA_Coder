import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { killTree } from './proctree.js';

export type ShellStatus = 'stopped' | 'starting' | 'ready' | 'error';

interface Pending {
  id: string;
  resolve: (result: { output: string; exitCode: number }) => void;
  chunks: string[];
  /** Prazo deste comando, para poder cancelá-lo quando a resposta chega. */
  timer?: NodeJS.Timeout;
}

/**
 * Prazo padrão de um comando.
 *
 * Um pendente preso na cabeça da fila não atrapalha só a si mesmo: `consume()`
 * olha exclusivamente `this.queue[0]`, então o marcador dos comandos seguintes
 * não casa com o id dele e a saída de todos vira `chunks` de quem travou. Um
 * login de OAuth abandonado no meio (você fechou o navegador e nunca colou o
 * código) envenenava assim o shell inteiro, sem nunca resolver nada.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Um PowerShell vivo, escondido, aberto na pasta do projeto.
 *
 * Fica de pé o tempo todo em vez de abrir um processo por comando: assim o
 * `cd` persiste, variáveis de ambiente e módulos carregados continuam valendo,
 * e cada comando custa milissegundos em vez de meio segundo de boot.
 *
 * Como saber onde termina a saída de um comando num fluxo contínuo? Depois de
 * cada comando mandamos um marcador único; tudo que vem antes dele é a saída,
 * e o número colado nele é o código de saída.
 */
export class ShellSession extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private queue: Pending[] = [];
  private seq = 0;

  status: ShellStatus = 'stopped';
  cwd: string;
  lastError: string | null = null;

  constructor(cwd: string) {
    super();
    this.cwd = cwd;
  }

  private get isPowerShell(): boolean {
    return /powershell|pwsh/i.test(config.shell.bin);
  }

  start(cwd = this.cwd): void {
    this.stop();
    this.cwd = cwd;
    this.setStatus('starting');

    const args = this.isPowerShell
      ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-']
      : ['-s'];

    try {
      this.child = spawn(config.shell.bin, args, {
        cwd,
        windowsHide: true, // nada de janela preta piscando na tela
        env: { ...process.env, IA_CODER: '1' },
      });
      this.child.on('spawn', () => this.emit('spawned'));
    } catch (error) {
      this.fail(String(error));
      return;
    }

    /*
     * Os ouvintes ficam presos AO FILHO que os registrou.
     *
     * `start()` derruba o shell antigo e sobe o novo no mesmo tick; o `exit` do
     * antigo só é entregue depois, quando `this.child` já é o novo. Sem esta
     * checagem de identidade, aquele `exit` atrasado zerava a referência do
     * shell RECÉM-ABERTO enquanto o `pwd` de confirmação punha o status em
     * 'ready' — e daí em diante todo `run()` devolvia "shell não está de pé",
     * fazendo os logins de auth e de MCP falharem em silêncio depois de
     * qualquer troca de projeto.
     */
    const child = this.child;
    const atual = (): boolean => this.child === child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (atual()) this.consume(chunk); });
    child.stderr.on('data', (chunk: string) => { if (atual()) this.emit('stderr', chunk); });
    child.on('error', (error) => { if (atual()) this.fail(error.message); });
    child.on('exit', (code) => {
      if (!atual()) return;
      this.child = null;
      // Morreu com comando pendente: ninguém mais vai imprimir o marcador que
      // resolveria essas promessas. Só o `stop()` esvaziava a fila, então uma
      // queda espontânea deixava quem esperava pendurado para sempre.
      this.drain();
      if (this.status !== 'error') this.setStatus('stopped');
      this.emit('exit', code);
    });

    // Confirma que o shell respondeu e que está na pasta certa.
    void this.run(this.isPowerShell ? 'Set-Location -LiteralPath $PWD; $PWD.Path' : 'pwd').then(
      (result) => {
        // Trocar de projeto derruba este shell com a confirmação ainda em voo, e
        // ela volta com código -1 (a fila é liberada no `stop`). Sem a checagem,
        // essa resposta atrasada punha o shell RECÉM-ABERTO em erro.
        if (!atual()) return;
        if (result.exitCode === 0) this.setStatus('ready');
        else this.fail(result.output.trim() || `código ${result.exitCode}`);
      },
    );
  }

  stop(): void {
    this.drain();
    this.buffer = '';
    /*
     * A árvore, não só o PowerShell.
     *
     * Matar o shell no meio de um `dotnet build` não para o `dotnet`: ele fica
     * rodando órfão, segurando arquivo e queimando CPU sem ninguém olhando —
     * que é o oposto do que "abortar" quer dizer.
     */
    killTree(this.child);
    this.child = null;
    if (this.status !== 'error') this.setStatus('stopped');
  }

  /**
   * Executa um comando e devolve a saída completa quando ele termina.
   *
   * @param timeoutMs prazo até desistir. Generoso para login de OAuth, que
   *   espera você aprovar no navegador — mas nunca infinito.
   */
  run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ output: string; exitCode: number }> {
    if (!this.child) return Promise.resolve({ output: 'shell não está de pé', exitCode: -1 });

    this.seq += 1;
    const id = `IACODER_${Date.now().toString(36)}_${this.seq}`;
    const marker = this.isPowerShell
      ? `Write-Output "<<${id}>>$LASTEXITCODE"`
      : `printf '<<%s>>%s\\n' "${id}" "$?"`;

    return new Promise((resolve) => {
      const pending: Pending = { id, resolve, chunks: [] };
      // Estourou o prazo: sai da fila para parar de engolir a saída dos comandos
      // seguintes, e quem chamou recebe uma resposta em vez de esperar até o fim
      // da sessão.
      pending.timer = setTimeout(() => {
        this.queue = this.queue.filter((item) => item !== pending);
        const aviso = `o comando passou de ${Math.round(timeoutMs / 1000)}s sem terminar`;
        resolve({ output: [...pending.chunks, aviso].join('\n'), exitCode: -1 });
      }, timeoutMs);
      pending.timer.unref?.();
      this.queue.push(pending);
      this.child?.stdin.write(`${command}\n${marker}\n`);
    });
  }

  /** Libera quem estava esperando — este shell não vai mais responder. */
  private drain(): void {
    const presos = this.queue;
    this.queue = [];
    presos.forEach((pending) => {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ output: pending.chunks.join('\n'), exitCode: -1 });
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);

      const pending = this.queue[0];
      const match = pending ? line.match(new RegExp(`^<<${pending.id}>>(-?\\d*)$`)) : null;

      if (pending && match) {
        this.queue.shift();
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve({
          output: pending.chunks.join('\n'),
          exitCode: match[1] === '' ? 0 : Number(match[1]),
        });
        continue;
      }

      if (pending) pending.chunks.push(line);
      this.emit('line', line);
    }
  }

  private setStatus(status: ShellStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  private fail(message: string): void {
    this.lastError = message;
    this.status = 'error';
    this.emit('status', 'error');
  }
}
