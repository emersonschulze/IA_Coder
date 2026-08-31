import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import type { ImageAttachment } from './protocol.js';

export type ClaudeStatus = 'stopped' | 'starting' | 'ready' | 'thinking' | 'error';

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TurnResult {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  isError: boolean;
}

export interface RateLimit {
  /** 0..1 — quanto da janela de 5 horas já foi consumido. */
  utilization: number;
  resetsAt: number;
  window: string;
}

/**
 * O Claude Code rodando de forma persistente na pasta do projeto.
 *
 * Em vez de abrir um processo por pedido, mantemos um só, alimentado por
 * stdin em JSON e lido por stdout em JSON. Duas consequências que importam:
 * o contexto da conversa sobrevive entre comandos (ele lembra o que você pediu
 * antes), e cada evento chega estruturado — dá para saber qual ferramenta ele
 * está usando e qual arquivo tocou, que é o que alimenta os blocos da tela.
 */
/** Aspas só onde precisa, no estilo que o cmd.exe entende. */
const quoteForWindows = (value: string): string =>
  /[\s"^&|<>]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;

/**
 * No Windows o `claude` é um `.cmd` (atalho do npm), e desde o Node 18.20 o
 * spawn se recusa a executar `.cmd` sem passar pelo shell. Só que passar
 * `args` junto de `shell: true` dispara o aviso DEP0190 — e com razão, porque
 * o Node concatena os argumentos sem escapar. Então no Windows montamos a
 * linha de comando nós mesmos, já com as aspas certas, e não passamos `args`.
 */
function spawnClaude(cwd: string, args: string[]): ChildProcessWithoutNullStreams {
  const options = { cwd, windowsHide: true, env: process.env } as const;
  if (process.platform !== 'win32') {
    return spawn(config.claude.bin, args, options);
  }
  const line = [config.claude.bin, ...args].map(quoteForWindows).join(' ');
  return spawn(line, { ...options, shell: true });
}

export class ClaudeSession extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';

  status: ClaudeStatus = 'stopped';
  cwd: string;
  sessionId: string | null = null;
  model: string | null = null;
  lastError: string | null = null;

  constructor(cwd: string) {
    super();
    this.cwd = cwd;
  }

  start(cwd = this.cwd): void {
    this.stop();
    this.cwd = cwd;
    this.setStatus('starting');

    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', config.claude.permissionMode,
    ];
    if (config.claude.model) args.push('--model', config.claude.model);

    try {
      this.child = spawnClaude(cwd, args);
    } catch (error) {
      this.fail(String(error));
      return;
    }

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.lastError = chunk.trim();
      this.emit('stderr', chunk);
    });
    this.child.on('error', (error) => this.fail(error.message));
    this.child.on('exit', (code) => {
      this.child = null;
      if (code !== 0 && code !== null) this.fail(this.lastError ?? `saiu com código ${code}`);
      else this.setStatus('stopped');
      this.emit('exit', code);
    });

    // O processo só se anuncia (system/init) depois da primeira mensagem;
    // até lá consideramos "pronto para receber".
    this.setStatus('ready');
  }

  stop(): void {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
    this.buffer = '';
    this.sessionId = null;
    if (this.status !== 'error') this.setStatus('stopped');
  }

  /**
   * Manda um pedido do usuário para a conversa em andamento.
   *
   * Imagens vêm primeiro no conteúdo, o texto depois — é a ordem que a API da
   * Anthropic recomenda para o modelo relacionar bem a instrução com a figura.
   */
  send(text: string, images?: ImageAttachment[]): boolean {
    if (!this.child?.stdin.writable) return false;
    const content: unknown[] = (images ?? []).map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    }));
    content.push({ type: 'text', text });
    const frame = { type: 'user', message: { role: 'user', content } };
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    this.setStatus('thinking');
    return true;
  }

  /**
   * Faz uma pergunta e devolve o texto da resposta. Usado para tarefas internas
   * (extrair o assunto para o Tree, por exemplo) e para o modo conversa — não
   * é execução de verdade.
   */
  ask(text: string, timeoutMs = 180_000, images?: ImageAttachment[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const parts: string[] = [];
      const onText = (chunk: string) => parts.push(chunk);
      const finish = (): void => {
        cleanup();
        resolve(parts.join('\n').trim());
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('text', onText);
        this.off('result', finish);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('o agente demorou demais para responder'));
      }, timeoutMs);

      this.on('text', onText);
      this.once('result', finish);

      if (!this.send(text, images)) {
        cleanup();
        reject(new Error('o Claude não está de pé'));
      }
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line) as Record<string, any>);
      } catch {
        /* linha parcial ou ruído: ignora */
      }
    }
  }

  private handle(event: Record<string, any>): void {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          this.sessionId = event.session_id ?? null;
          this.model = event.model ?? null;
          this.emit('init', { sessionId: this.sessionId, cwd: event.cwd, model: this.model });
        }
        break;

      case 'assistant': {
        const content: any[] = event.message?.content ?? [];
        content.forEach((block) => {
          if (block.type === 'text' && block.text?.trim()) {
            this.emit('text', block.text as string);
          }
          if (block.type === 'tool_use') {
            this.emit('tool', {
              id: block.id,
              name: block.name,
              input: block.input ?? {},
            } satisfies ToolUse);
          }
        });
        break;
      }

      case 'user': {
        // Resultado de ferramenta volta como mensagem do "usuário".
        const content: any[] = event.message?.content ?? [];
        content.forEach((block) => {
          if (block.type === 'tool_result') {
            this.emit('tool_result', {
              id: block.tool_use_id,
              isError: Boolean(block.is_error),
              text: typeof block.content === 'string' ? block.content : '',
            });
          }
        });
        break;
      }

      case 'rate_limit_event': {
        const info = event.rate_limit_info ?? {};
        const five = info.unifiedWindows?.five_hour;
        if (five) {
          this.emit('rate_limit', {
            utilization: Number(five.utilization ?? 0),
            resetsAt: Number(five.resetsAt ?? 0) * 1000,
            window: 'five_hour',
          } satisfies RateLimit);
        }
        break;
      }

      case 'result': {
        this.setStatus('ready');
        const usage = event.usage ?? {};
        this.emit('result', {
          costUsd: Number(event.total_cost_usd ?? 0),
          inputTokens: Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          durationMs: Number(event.duration_api_ms ?? 0),
          isError: event.subtype !== undefined && event.subtype !== 'success',
        } satisfies TurnResult);
        break;
      }

      default:
        break;
    }
  }

  private setStatus(status: ClaudeStatus): void {
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
