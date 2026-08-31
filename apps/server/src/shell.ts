import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

export type ShellStatus = 'stopped' | 'starting' | 'ready' | 'error';

interface Pending {
  id: string;
  resolve: (result: { output: string; exitCode: number }) => void;
  chunks: string[];
}

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

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.on('data', (chunk: string) => this.emit('stderr', chunk));
    this.child.on('error', (error) => this.fail(error.message));
    this.child.on('exit', (code) => {
      this.child = null;
      if (this.status !== 'error') this.setStatus('stopped');
      this.emit('exit', code);
    });

    // Confirma que o shell respondeu e que está na pasta certa.
    void this.run(this.isPowerShell ? 'Set-Location -LiteralPath $PWD; $PWD.Path' : 'pwd').then(
      (result) => {
        if (result.exitCode === 0) this.setStatus('ready');
        else this.fail(result.output.trim() || `código ${result.exitCode}`);
      },
    );
  }

  stop(): void {
    this.queue.forEach((pending) => pending.resolve({ output: '', exitCode: -1 }));
    this.queue = [];
    this.buffer = '';
    this.child?.kill();
    this.child = null;
    if (this.status !== 'error') this.setStatus('stopped');
  }

  /** Executa um comando e devolve a saída completa quando ele termina. */
  run(command: string): Promise<{ output: string; exitCode: number }> {
    if (!this.child) return Promise.resolve({ output: 'shell não está de pé', exitCode: -1 });

    this.seq += 1;
    const id = `IACODER_${Date.now().toString(36)}_${this.seq}`;
    const marker = this.isPowerShell
      ? `Write-Output "<<${id}>>$LASTEXITCODE"`
      : `printf '<<%s>>%s\\n' "${id}" "$?"`;

    return new Promise((resolve) => {
      this.queue.push({ id, resolve, chunks: [] });
      this.child?.stdin.write(`${command}\n${marker}\n`);
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
