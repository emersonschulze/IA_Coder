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
  /**
   * A resposta INTEIRA, para ler na tela.
   *
   * Só aparece quando ela é maior do que a fala — ou seja, quando o agente
   * respondeu em prosa em vez do JSON combinado. Existe porque as duas coisas
   * têm limites opostos: voz quer duas frases, leitura quer a resposta toda.
   * Enquanto era um campo só, a resposta escrita saía picotada no meio da
   * palavra, e o que o Talking mostrava simplesmente não era o que ele disse.
   */
  text?: string;
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
  /**
   * Em qual PROCESSO do Claude o enquadramento já foi entregue.
   *
   * O `FRAME` mora no contexto do processo, não neste histórico — e o processo é
   * derrubado e resubido em vários caminhos (trocar de projeto, abortar,
   * reiniciar o runtime, login de auth ou de MCP). Enquanto o critério era
   * "primeira mensagem da conversa", o processo novo nascia sem regra nenhuma e
   * nunca mais recebia: o agente voltava a responder em prosa, `parseReply` caía
   * no plano B, tudo virava `mode: 'chat'` e o cartão de plano com o "Pode ir" —
   * a única porta de execução da ferramenta — não aparecia mais até reiniciar o
   * servidor.
   */
  private framedGeneration = -1;
  /** Plano aguardando o "pode ir". */
  pending: Plan | null = null;

  constructor(private readonly claude: ClaudeSession) {}

  get transcript(): { role: 'user' | 'agent'; text: string }[] {
    return this.history;
  }

  reset(): void {
    this.history = [];
    this.pending = null;
    this.framedGeneration = -1;
  }

  /**
   * Registra uma fala que nao passou pelo Claude - o clique em "Pode ir", por
   * exemplo. Sem isso a conversa que ele lembra fica com um buraco: o plano
   * seria executado sem ninguem ter dito sim.
   */
  note(role: 'user' | 'agent', text: string): void {
    this.history.push({ role, text });
  }

  async say(text: string, images?: ImageAttachment[]): Promise<Reply> {
    this.history.push({ role: 'user', text });

    // Processo novo, contexto zerado: reenquadra e leva junto um resumo curto do
    // que já foi conversado, senão ele responde sem saber do que se trata.
    const enquadradoAntes = this.framedGeneration;
    const precisaEnquadrar = enquadradoAntes !== this.claude.generation;
    const prompt = precisaEnquadrar
      ? [FRAME, this.recap(), `O desenvolvedor disse: "${text}"`].filter(Boolean).join('\n\n')
      : `O desenvolvedor disse: "${text}"`;
    this.framedGeneration = this.claude.generation;

    // 4 minutos SEM SINAL DE VIDA, não 4 minutos de trabalho: cada arquivo lido
    // renova o prazo. O limite antigo era de duração total e derrubava análise
    // de repositório grande no meio, dizendo que o agente demorou demais quando
    // ele estava trabalhando.
    let answer: string;
    try {
      answer = await this.claude.ask(prompt, 240_000, images);
    } catch (error) {
      // Deu errado: não dá para afirmar que o enquadramento chegou lá dentro —
      // um `ask` recusado de saída (turno anterior ainda aberto) não envia nada.
      // Reenviar de graça custa alguns tokens; deixar o processo sem regra
      // nenhuma custa o cartão de plano, que é a única porta de execução.
      this.framedGeneration = enquadradoAntes;
      throw error;
    }
    const reply = parseReply(answer);

    // O que ele lembra é o que ele DISSE por inteiro, não o resumo falado:
    // guardar a versão curta apagava metade da própria resposta do contexto.
    this.history.push({ role: 'agent', text: reply.text ?? reply.say });
    this.pending = reply.mode === 'plan' ? (reply.plan ?? null) : null;
    return reply;
  }

  /**
   * O que já foi conversado, em poucas linhas, para um processo que não estava
   * aqui. Só as últimas trocas: o objetivo é ele não recomeçar do zero, não
   * reconstruir a conversa inteira.
   */
  private recap(): string {
    const anteriores = this.history.slice(-7, -1);
    if (anteriores.length === 0) return '';
    return [
      'Retomando (o processo foi reaberto e você perdeu o contexto). O que já foi dito:',
      ...anteriores.map(({ role, text }) => `- ${role === 'user' ? 'Dev' : 'Você'}: ${text.slice(0, 400)}`),
    ].join('\n');
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
  // Tirar as cercas de código só faz sentido enquanto caçamos o JSON. Fazer
  // isso no texto que vai para a tela estraga qualquer resposta que traga um
  // bloco de código — e prosa com código é justamente o plano B aqui embaixo.
  const unfenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');

  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1)) as Partial<Reply>;
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

  /*
   * Plano B: ele respondeu em prosa.
   *
   * A prosa vai INTEIRA para a tela; o corte em 320 caracteres serve só para a
   * voz, que não pode ler três parágrafos. Eram a mesma coisa antes, e o
   * resultado era a resposta escrita terminando no meio de uma frase — o texto
   * existia, mas ninguém conseguia ler o final.
   */
  const prose = raw.trim();
  if (!prose) return { mode: 'chat', say: 'Desculpa, não consegui formular a resposta.' };

  const spoken = speakable(prose);
  return { mode: 'chat', say: spoken, text: prose === spoken ? undefined : prose };
}

/** Limite de fala: uma frase inteira, nunca uma palavra pela metade. */
const SPOKEN_LIMIT = 320;

/**
 * A versão falável de uma resposta escrita.
 *
 * Marcação não se lê em voz alta ("asterisco asterisco bloqueada") e frase
 * cortada no meio soa como pane, então cortamos na última pontuação que couber
 * e só recuamos para o espaço quando não há nenhuma.
 */
export function speakable(prose: string): string {
  const flat = prose
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (flat.length <= SPOKEN_LIMIT) return flat;

  const head = flat.slice(0, SPOKEN_LIMIT);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence > SPOKEN_LIMIT / 2) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : head).trim()}…`;
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
