import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceLoop } from '@/hooks/useVoiceLoop';
import { useVoiceOut } from '@/hooks/useVoiceOut';
import { useSession } from '@/store/useSession';
import type { ImageAttachment } from '@/types/domain';
import { BubbleText } from './BubbleText';
import { Panel } from './Panel';
import styles from './ConversationPanel.module.css';

interface Props {
  onInput: (text: string, images?: ImageAttachment[]) => void;
  onConfirm: (accept: boolean) => void;
  onSaveKnowledge: () => void;
  /** Recusa guardar esta análise — o convite some e nada vai para o banco. */
  onDiscardKnowledge: () => void;
  /** `/tree` — abre o formulário de assunto escrito por você. */
  onOpenSubjectForm: (title: string) => void;
  /** Abre o arquivo gerado com o programa padrão do Windows. */
  onOpenArtifact: (path: string, reveal?: boolean) => void;
  /** O botão 🔊 da barra. */
  ttsEnabled: boolean;
}

/** Uma imagem anexada, ainda no navegador — pronta para virar mensagem. */
interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  data: string;
  previewUrl: string;
}

const BARS = 22;
/** Maior lado de uma imagem anexada, em pixels — o resto é o tamanho do arquivo. */
const MAX_IMAGE_DIM = 1600;
const MAX_ATTACHMENTS = 6;

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** O microfone ouviu a própria voz do agente? */
function echoes(heard: string, said: string): boolean {
  const a = normalize(heard);
  const b = normalize(said);
  if (a.length < 4 || b.length < 4) return false;
  return b.includes(a) || a.includes(b);
}

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('falha lendo o arquivo'));
    reader.readAsDataURL(blob);
  });
}

/** Reduz a imagem antes de mandar — economiza banda e token sem perder o essencial. */
async function toAttachment(file: File): Promise<Attachment> {
  const id = crypto.randomUUID();
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    const data = await readAsBase64(file);
    const mediaType = file.type || 'image/png';
    return { id, name: file.name, mediaType, data, previewUrl: `data:${mediaType};base64,${data}` };
  }
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
  const mediaType = 'image/jpeg';
  const previewUrl = canvas.toDataURL(mediaType, 0.85);
  return { id, name: file.name, mediaType, data: previewUrl.split(',')[1] ?? '', previewUrl };
}

/**
 * Talking — a conversa com o IA_Coder.
 *
 * Uma caixa só, sempre a mesma: escreva ou fale, ele vai respondendo e o
 * histórico fica na tela, como um chat. Quando ele entende um pedido de
 * verdade, monta um plano e pergunta antes de mexer em qualquer arquivo — um
 * "pode mandar" (falado, escrito ou clicado) é o que dispara a execução, e o
 * resultado (resumo e arquivos gerados) aparece aqui mesmo, na sequência.
 *
 * O modo "microfone" (o botão CONVERSA na barra de cima) só liga a escuta de
 * mãos livres; escrever sempre funcionou e continua funcionando com ele
 * desligado.
 */
export function ConversationPanel({
  onInput, onConfirm, onSaveKnowledge, onDiscardKnowledge, onOpenSubjectForm, onOpenArtifact,
  ttsEnabled,
}: Props) {
  const conversation = useSession((state) => state.conversation);
  const turns = useSession((state) => state.turns);
  const voice = useSession((state) => state.voice);
  const lastSay = useSession((state) => state.lastSay);
  const connection = useSession((state) => state.connection);
  const result = useSession((state) => state.result);
  const workflowState = useSession((state) => state.workflow?.state);
  const treeReady = useSession((state) => state.treeStatus === 'ok');
  const reused = useSession((state) => state.reusedSubjects);

  const [error, setError] = useState<string | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [saved, setSaved] = useState(false);
  /*
   * Já respondi este plano.
   *
   * Sem isto o clique não deixava rastro nenhum na tela: com o servidor fora do
   * ar, o `IaCoderSocket` guarda o comando na fila e o entrega sozinho na
   * reconexão — o usuário concluía que não passou, saía da frente do
   * computador, e 15s depois a execução começava sem ninguém olhando. O botão
   * agora ou está bloqueado (offline) ou diz que a resposta saiu.
   */
  const [answered, setAnswered] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const bars = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const spokenAt = useRef(0);
  const quietUntil = useRef(0);
  const lastAgentText = useRef('');
  const busy = useRef(false);
  busy.current = conversation.thinking;

  const out = useVoiceOut();
  const speak = out.speak;

  // O botão de guardar só faz sentido depois que a análise terminou bem.
  const canSave = workflowState === 'done' && treeReady;
  /*
   * Guardar e atualizar são ações diferentes e a tela precisa dizer qual é.
   *
   * Se esta análise nasceu em cima de um assunto que já está no Tree, gravá-la
   * como nova não cria conhecimento: cria um segundo assunto sobre a mesma
   * coisa, e da próxima vez os dois voltam como contexto. O que se quer ali é
   * reescrever aquele — e o botão tem que dizer isso ANTES do clique, não
   * depois.
   */
  const updating = reused[0] ?? null;
  useEffect(() => setSaved(false), [workflowState]);
  // Plano novo (ou plano que sumiu) libera os botões de novo.
  useEffect(() => setAnswered(false), [conversation.pending]);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    const images = Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return;
    void Promise.all(images.map(toAttachment)).then((converted) => {
      setAttachments((prev) => [...prev, ...converted].slice(0, MAX_ATTACHMENTS));
    });
  }, []);

  /** Uma fala terminada: manda o áudio para o Whisper e decide o que fazer. */
  const onUtterance = useCallback(
    async (audio: Blob) => {
      try {
        const response = await fetch('/voice/stt', {
          method: 'POST',
          headers: { 'content-type': audio.type || 'audio/webm' },
          body: audio,
        });
        if (!response.ok) throw new Error(`transcrição indisponível (${response.status})`);

        const data = (await response.json()) as { text: string; wake: boolean; command: string };
        const text = data.text?.trim();
        if (!text) return;

        // Ele não pode responder a si mesmo. Duas travas: um instante de
        // silêncio depois que a fala termina (o microfone ainda ouve o eco da
        // caixa de som) e a comparação com o que ele acabou de dizer.
        if (Date.now() < quietUntil.current) return;
        if (echoes(text, lastAgentText.current)) return;

        setError(null);

        /*
         * Com o microfone ligado, ele JÁ está te ouvindo: o silêncio é o
         * Enter. Exigir a palavra de ativação a cada frase era o que fazia a
         * fala sumir sem resposta — bastava o Whisper transcrever "ia coder"
         * de um jeito um pouco diferente. A palavra continua servindo para
         * chamá-lo pelo nome; quando vem, só tiramos ela do começo.
         */
        const command = (data.wake ? data.command : text).trim();
        setHeard(command || text);

        // Duas sílabas soltas quase nunca são um pedido.
        if (command.length < 3) return;
        // Uma pergunta por vez: enquanto ele pensa, o resto espera.
        if (busy.current) return;

        onInput(command);
      } catch (problem) {
        setError((problem as Error).message);
      }
    },
    [onInput],
  );

  /** A única forma de mandar mensagem — escrita, com ou sem imagem anexada. */
  const submitMessage = useCallback(() => {
    const value = typed.trim();
    if (!value && attachments.length === 0) return;

    /*
     * `/tree` não é uma mensagem para o agente — é um comando da ferramenta.
     *
     * Vale mesmo com ele pensando ou fora do ar: guardar o que VOCÊ entendeu
     * não depende de nenhum turno. O que vem depois do comando vira o nome
     * sugerido do nó, então `/tree identidade e SSO` já abre preenchido.
     */
     const comando = /^\/(tree|assunto|salvar)\s*/i.exec(value);
    if (comando) {
      onOpenSubjectForm(value.slice(comando[0].length).trim());
      setTyped('');
      return;
    }

    // Durante uma execução o servidor não atende a conversa: a pergunta
    // sequestraria o turno da execução. Não adianta mandar.
    if (conversation.thinking || conversation.executing) return;
    const images = attachments.length > 0
      ? attachments.map(({ mediaType, data, name }) => ({ mediaType, data, name }))
      : undefined;
    onInput(value || 'Veja a imagem em anexo.', images);
    setTyped('');
    setAttachments([]);
  }, [typed, attachments, conversation.thinking, conversation.executing, onInput, onOpenSubjectForm]);

  // Ctrl+Enter envia de qualquer lugar da tela — o velho hábito continua valendo.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submitMessage();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [submitMessage]);

  const loop = useVoiceLoop({
    active: conversation.active,
    onUtterance,
    onError: setError,
  });
  const setMuted = loop.setMuted;
  const levelRef = loop.levelRef;

  // Enquanto ele fala, o microfone fica fechado — e continua fechado por um
  // instante depois, para o eco da caixa de som não virar pergunta.
  useEffect(() => {
    setMuted(out.speaking);
    if (!out.speaking) quietUntil.current = Date.now() + 900;
  }, [out.speaking, setMuted]);

  /**
   * O único ponto da aplicação que fala.
   *
   * Fica aqui de propósito: é este componente que abre o microfone, então só
   * ele consegue fechá-lo antes de falar. Com a fala espalhada, o agente se
   * ouvia e respondia a si mesmo.
   */
  useEffect(() => {
    if (!lastSay || lastSay.at <= spokenAt.current) return;
    spokenAt.current = lastSay.at;
    lastAgentText.current = lastSay.text;
    quietUntil.current = Date.now() + 30_000; // liberado quando a fala terminar
    if (ttsEnabled) void speak(lastSay.text);
  }, [lastSay, ttsEnabled, speak]);

  // Sempre no fim: fala nova, resultado ou plano recém-proposto. O plano
  // entrando é o caso que mais importa — é onde estão os botões de resposta.
  useEffect(() => {
    const node = feed.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length, result, conversation.pending, conversation.thinking]);

  // Waveform fora do React: 60 quadros por segundo não podem virar render.
  useEffect(() => {
    let frame = 0;
    const paint = (): void => {
      const nodes = bars.current?.children;
      if (nodes) {
        const level = levelRef.current;
        for (let i = 0; i < nodes.length; i += 1) {
          const wave = Math.abs(Math.sin(performance.now() / 190 + i * 0.5));
          const height = 4 + level * 150 * (0.45 + wave * 0.75);
          (nodes[i] as HTMLElement).style.height = `${Math.min(30, height).toFixed(1)}px`;
        }
      }
      frame = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(frame);
  }, [levelRef]);

  const status = !conversation.active
    ? 'mic desligado'
    : out.speaking
      ? 'falando'
      : conversation.thinking
        ? 'pensando'
        : 'ouvindo';

  // De onde sai o som importa: "mudo" explica por que você não ouve nada.
  const voiceBadge = out.source === 'piper' ? '' : ` · voz ${out.source}`;

  // Por que os botões do plano estão bloqueados, quando estão. `null` = livres.
  const planTitle =
    connection !== 'open'
      ? 'sem link com o servidor'
      : answered
        ? 'resposta já enviada — esperando o servidor'
        : null;

  return (
    <Panel
      title="Talking"
      badge={`${status}${voiceBadge}`}
      zoomable
      style={{ flex: '2 1 0px', minHeight: 320 }}
    >
      <div className={styles.wrap}>
        {conversation.active && (
          <div
            className={[styles.wave, out.speaking ? '' : styles.waveAwake].filter(Boolean).join(' ')}
            ref={bars}
          >
            {Array.from({ length: BARS }, (_, index) => (
              <i key={index} className={styles.bar} />
            ))}
          </div>
        )}

        {voice && !voice.stt && conversation.active && (
          <p className={styles.warn}>
            Whisper fora do ar — suba com <code>docker compose --profile voice up -d</code>.
          </p>
        )}
        {error && <p className={styles.warn}>{error}</p>}
        {out.error && <p className={styles.warn}>voz: {out.error}</p>}

        <div className={styles.feed} ref={feed}>
          {turns.length === 0 && (
            <p className={styles.off}>Escreva ali embaixo, ou ligue o microfone na barra de cima.</p>
          )}
          {turns.map((turn, index) => (
            <div key={`${turn.at}-${index}`} className={turn.role === 'user' ? styles.mine : styles.theirs}>
              {turn.images && turn.images.length > 0 && (
                <div className={styles.bubbleImages}>
                  {turn.images.map((image, imageIndex) => (
                    <img
                      key={imageIndex}
                      src={`data:${image.mediaType};base64,${image.data}`}
                      alt={image.name ?? 'imagem enviada'}
                    />
                  ))}
                </div>
              )}
              <BubbleText text={turn.text} />
            </div>
          ))}
          {/* O que ele está FAZENDO aparece no centro, como bloco e seta —
              ler arquivo é trabalho, e trabalho não mora na conversa. Aqui fica
              só o sinal de que ele está pensando. */}
          {conversation.thinking && <div className={styles.thinking}>pensando…</div>}
          {conversation.executing && !conversation.thinking && (
            <div className={styles.thinking}>executando — te aviso quando terminar</div>
          )}

          {result && (result.artifacts.length > 0 || canSave) && (
            <div className={styles.resultRow}>
              {result.artifacts.length > 0 && (
                <div className={styles.artifacts}>
                  {result.artifacts.map((artifact) => (
                    <button
                      key={artifact.id}
                      type="button"
                      className={styles.artifact}
                      onClick={() => artifact.href && onOpenArtifact(artifact.href)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (artifact.href) onOpenArtifact(artifact.href, true);
                      }}
                      title={`${artifact.href ?? artifact.name}\n(clique abre · botão direito mostra na pasta)`}
                    >
                      ↗ {artifact.name}
                    </button>
                  ))}
                </div>
              )}
              {canSave && (
                <div className={styles.keepRow}>
                  <button
                    type="button"
                    className={styles.save}
                    disabled={saved}
                    onClick={() => {
                      onSaveKnowledge();
                      setSaved(true);
                    }}
                    title={updating
                      ? `Reescreve “${updating.title}” com o que saiu desta análise — resumo e stack`
                      : 'Grava esta análise como assunto reutilizável — da próxima vez ela entra como contexto pronto'}
                  >
                    {saved
                      ? (updating ? '✓ atualizado' : '✓ guardado')
                      : (updating ? `↻ Atualizar “${updating.title}”` : '✓ Guardar no Tree')}
                  </button>
                  {!saved && (
                    <button
                      type="button"
                      className={styles.discard}
                      onClick={() => {
                        onDiscardKnowledge();
                        setSaved(false);
                      }}
                      title="Não guarda nada — esta análise não vira assunto do Tree"
                    >
                      ✕ Descartar
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/*
            O plano mora DENTRO da conversa, não abaixo dela.
            Fora do feed ele empurrava a caixa de digitar para fora do painel:
            um plano de seis passos não cabia, não rolava, e você ficava vendo
            uma pergunta que não tinha como responder. Aqui ele é a última fala
            do agente — rola junto com o resto e os botões sempre chegam.
          */}
          {conversation.pending && (
            <div className={styles.plan}>
              <div className={styles.planHead}>
                <span className={styles.risk} data-risk={conversation.pending.risk}>
                  risco {conversation.pending.risk}
                </span>
                <strong>{conversation.pending.title}</strong>
              </div>
              <ol className={styles.steps}>
                {conversation.pending.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
              <div className={styles.confirm}>
                <button
                  type="button"
                  className={styles.go}
                  disabled={connection !== 'open' || answered}
                  title={planTitle ?? 'Executa o plano acima'}
                  onClick={() => {
                    setAnswered(true);
                    onConfirm(true);
                  }}
                >
                  ▶ Pode ir
                </button>
                <button
                  type="button"
                  className={styles.no}
                  disabled={connection !== 'open' || answered}
                  title={planTitle ?? 'Descarta o plano — nada é executado'}
                  onClick={() => {
                    setAnswered(true);
                    onConfirm(false);
                  }}
                >
                  ✕ Agora não
                </button>
              </div>
              <p className={styles.tip}>
                {connection !== 'open'
                  ? 'Sem link com o servidor — a resposta só sai quando a conexão voltar.'
                  : answered
                    ? 'Resposta enviada — esperando o servidor.'
                    : 'Ou responda: “pode mandar”.'}
              </p>
            </div>
          )}
        </div>

        {attachments.length > 0 && (
          <div className={styles.pendingImages}>
            {attachments.map((attachment) => (
              <div key={attachment.id} className={styles.pendingImage}>
                <img src={attachment.previewUrl} alt={attachment.name} />
                <button
                  type="button"
                  className={styles.pendingRemove}
                  onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== attachment.id))}
                  title="Remover"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            submitMessage();
          }}
        >
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className={styles.attachButton}
            onClick={() => fileInput.current?.click()}
            title="Anexar imagem"
          >
            📎
          </button>
          <textarea
            className={styles.composerInput}
            rows={1}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitMessage();
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.length > 0) {
                event.preventDefault();
                addFiles(files);
              }
            }}
            placeholder="Aqui o texto que posso digitar… (/tree guarda um assunto)"
          />
          <button
            type="submit"
            className={styles.composerSend}
            disabled={
              (!typed.trim() && attachments.length === 0) ||
              connection !== 'open' ||
              conversation.thinking ||
              conversation.executing
            }
            title={
              connection !== 'open'
                ? 'sem link com o servidor'
                : conversation.executing
                  ? 'ele está executando — use o Abortar se quiser parar'
                  : conversation.thinking
                    ? 'espera ele responder…'
                    : 'Enviar (Enter)'
            }
          >
            ➤
          </button>
        </form>

        {connection !== 'open' && (
          <p className={styles.warn}>sem link com o servidor local — a mensagem só sai quando a conexão voltar</p>
        )}

        {conversation.active && (
          <p className={styles.heard}>
            {conversation.thinking
              ? 'processando o que você falou…'
              : heard
                ? `ouvi: “${heard}”`
                : 'fale à vontade — 1,5s de silêncio envia'}
          </p>
        )}
      </div>
    </Panel>
  );
}
