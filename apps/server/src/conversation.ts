import type { ClaudeSession } from './claude.js';
import type { ImageAttachment } from './protocol.js';

export type ConversationMode = 'chat' | 'ask' | 'plan';

export interface Plan {
  title: string;
  steps: string[];
  risk: 'low' | 'medium' | 'high';
}

export interface Reply {
  mode: ConversationMode;
  /** O que será falado em voz alta. Curto de propósito. */
  say: string;
  plan?: Plan;
}

/**
 * O enquadramento do modo conversa.
 *
 * Duas regras carregam o resto: responder em JSON (para a interface saber se é
 * pergunta, plano ou papo) e **não tocar em arquivo nenhum** enquanto conversa.
 * A execução só acontece depois do seu "pode ir" — que vira um pedido comum,
 * pelo caminho normal do workflow.
 */
const FRAME = [
  'Você está no MODO CONVERSA do IA_Coder, falando por voz com um desenvolvedor em português do Brasil.',
  '',
  'Responda SEMPRE com um único objeto JSON válido, sem texto antes ou depois, sem cercas de código:',
  '{"mode":"chat|ask|plan","say":"…","plan":{"title":"…","steps":["…"],"risk":"low|medium|high"}}',
  '',
  'Quando usar cada modo:',
  '- "chat": responder uma dúvida, explicar algo, conversar. Nada a executar.',
  '- "ask": falta informação para agir. Faça UMA pergunta por vez, a mais importante.',
  '- "plan": você entendeu o pedido e sabe o que fazer. Em "say", resuma em uma frase e',
  '  pergunte se pode executar. Em "plan", detalhe os passos.',
  '',
  'Regras da fala ("say"):',
  '- No máximo 2 frases curtas. Isso vai ser LIDO EM VOZ ALTA.',
  '- Nada de markdown, listas, código ou caminho de arquivo comprido na fala.',
  '- Trate a pessoa por "você". Direto, sem cerimônia e sem repetir o que ela disse.',
  '',
  'Regra dura: NESTE MODO você não edita, não cria e não apaga arquivo, e não roda comando',
  'que altere qualquer coisa. Pode ler e investigar à vontade para responder bem.',
  'A execução só acontece depois que a pessoa confirmar.',
].join('\n');

/**
 * Conduz a conversa por voz.
 *
 * Cada rodada é um turno "silencioso" no mesmo processo do Claude: o contexto
 * do projeto continua valendo, e nada disso vira bloco na tela — os blocos são
 * para execução de verdade.
 */
export class Conversation {
  private history: { role: 'user' | 'agent'; text: string }[] = [];
  /** Plano aguardando o "pode ir". */
  pending: Plan | null = null;

  constructor(private readonly claude: ClaudeSession) {}

  get transcript(): { role: 'user' | 'agent'; text: string }[] {
    return this.history;
  }

  reset(): void {
    this.history = [];
    this.pending = null;
  }

  async say(text: string, images?: ImageAttachment[]): Promise<Reply> {
    this.history.push({ role: 'user', text });

    const isFirst = this.history.length === 1;
    const prompt = isFirst ? `${FRAME}\n\nO desenvolvedor disse: "${text}"` : `O desenvolvedor disse: "${text}"`;

    const answer = await this.claude.ask(prompt, 120_000, images);
    const reply = parseReply(answer);

    this.history.push({ role: 'agent', text: reply.say });
    this.pending = reply.mode === 'plan' ? (reply.plan ?? null) : null;
    return reply;
  }

  /** Vira o plano confirmado em um pedido de execução para o workflow. */
  executionPrompt(): string | null {
    if (!this.pending) return null;
    const { title, steps } = this.pending;
    return [
      `Execute agora o que combinamos: ${title}`,
      '',
      'Passos acordados:',
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      'Pode editar arquivos e rodar comandos. Ao terminar, resuma em duas frases o que mudou.',
    ].join('\n');
  }
}

/**
 * O agente às vezes embrulha o JSON em texto ou devolve prosa pura.
 * Nos dois casos a conversa tem que continuar — nunca travar por formato.
 */
export function parseReply(raw: string): Reply {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<Reply>;
      if (parsed.say) {
        const mode: ConversationMode =
          parsed.mode === 'ask' || parsed.mode === 'plan' ? parsed.mode : 'chat';
        return {
          mode,
          say: String(parsed.say).trim(),
          plan: mode === 'plan' ? normalizePlan(parsed.plan) : undefined,
        };
      }
    } catch {
      /* cai no plano B */
    }
  }

  // Plano B: trata como conversa e fala as primeiras frases.
  const spoken = cleaned.replace(/\s+/g, ' ').trim().slice(0, 320);
  return { mode: 'chat', say: spoken || 'Desculpa, não consegui formular a resposta.' };
}

function normalizePlan(plan: Plan | undefined): Plan | undefined {
  if (!plan?.title) return undefined;
  const risk = plan.risk === 'high' || plan.risk === 'medium' ? plan.risk : 'low';
  return {
    title: String(plan.title).trim(),
    steps: Array.isArray(plan.steps) ? plan.steps.map(String).slice(0, 12) : [],
    risk,
  };
}

/** Reconhece um "pode ir" falado, sem precisar de botão. */
export function soundsLikeYes(text: string): boolean {
  return /\b(pode (ir|fazer|mandar|executar)|manda(r)? (ver|bala)?|isso|isso a[ií]|confirmo|confirmado|vai(\s|$)|bora|faz(er)? isso|sim|ok|certo|perfeito|beleza|t[aá] (bom|certo)|executa(r)?)\b/i
    .test(text.trim());
}

export function soundsLikeNo(text: string): boolean {
  return /\b(n[ãa]o|nao|espera|calma|para|cancela(r)?|deixa (pra l[áa]|quieto)|melhor n[ãa]o)\b/i
    .test(text.trim());
}
