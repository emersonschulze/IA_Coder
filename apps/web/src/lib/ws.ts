import { isServerEvent, type ClientCommand, type ConnectionState, type ServerEvent } from '@/types/protocol';

const DEFAULT_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8787/ws';

interface Options {
  url?: string;
  onEvent: (event: ServerEvent) => void;
  onState: (state: ConnectionState, detail?: string) => void;
}

/**
 * Cliente WebSocket do IA_Coder.
 * - reconexão com backoff exponencial (1s → 15s) e jitter
 * - fila de comandos enquanto o socket está fechado
 * - keepalive a cada 20s para detectar link morto
 */
export class IaCoderSocket {
  private readonly url: string;
  private readonly onEvent: Options['onEvent'];
  private readonly onState: Options['onState'];

  private socket: WebSocket | null = null;
  private queue: ClientCommand[] = [];
  private attempt = 0;
  private disposed = false;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  /**
   * Ping enviado e ainda sem `pong` de volta.
   *
   * Num link meio-aberto — notebook que hiberna, troca de Wi-Fi para o cabo —
   * não chega FIN: `onclose` não dispara, `readyState` continua OPEN e o
   * `send()` abaixo entrega o comando ao buffer do kernel sem erro nenhum. O
   * pedido some sem entrar na fila e sem reconexão, que é justamente o caso
   * para o qual a fila existe.
   */
  private awaitingPong = false;

  constructor(options: Options) {
    this.url = options.url ?? DEFAULT_URL;
    this.onEvent = options.onEvent;
    this.onState = options.onState;
  }

  connect(): void {
    if (this.disposed) return;
    this.clearRetry();
    this.onState(this.attempt === 0 ? 'connecting' : 'reconnecting', this.url);

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.scheduleRetry(String(error));
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.onState('open', this.url);
      this.flush();
      this.startKeepalive();
    };

    socket.onmessage = (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!isServerEvent(parsed)) return;
      // Qualquer frame prova que o link está vivo, mas o `pong` é o único que
      // chega mesmo quando não há nada acontecendo do lado do servidor.
      if (parsed.type === 'pong') this.awaitingPong = false;
      this.onEvent(parsed);
    };

    socket.onclose = (event) => {
      this.stopKeepalive();
      this.socket = null;
      this.scheduleRetry(`close ${event.code}`);
    };

    socket.onerror = () => {
      /* onclose sempre vem depois; a reconexão é tratada lá. */
    };
  }

  send(command: ClientCommand): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(command));
      return;
    }
    // Guarda no máximo 50 comandos para não vazar memória em offline longo.
    this.queue = [...this.queue.slice(-49), command];
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
    this.stopKeepalive();
    this.socket?.close();
    this.socket = null;
  }

  private flush(): void {
    const pending = this.queue;
    this.queue = [];
    pending.forEach((command) => this.send(command));
  }

  private scheduleRetry(detail: string): void {
    if (this.disposed) return;
    this.onState('reconnecting', detail);
    const base = Math.min(15_000, 1_000 * 2 ** this.attempt);
    const delay = base + Math.random() * 400;
    this.attempt += 1;
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingTimer = window.setInterval(() => {
      // O ping anterior ficou sem resposta: o link está morto por baixo, mesmo
      // com o `readyState` dizendo OPEN. Fechar à mão é o que aciona
      // `onclose` → `scheduleRetry` e faz os próximos comandos irem para a
      // fila, em vez de se perderem num socket que ninguém está lendo.
      if (this.awaitingPong) {
        this.socket?.close();
        return;
      }
      this.awaitingPong = true;
      this.send({ type: 'ping' });
    }, 20_000);
  }

  private stopKeepalive(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.awaitingPong = false;
  }
}
