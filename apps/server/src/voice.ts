import { config } from './config.js';

const WHISPER = process.env.WHISPER_URL ?? 'http://localhost:9000';
const PIPER = process.env.PIPER_URL ?? 'http://localhost:5002';

export interface VoiceHealth {
  stt: boolean;
  tts: boolean;
  checkedAt: number;
}

let health: VoiceHealth = { stt: false, tts: false, checkedAt: 0 };

export const voiceHealth = (): VoiceHealth => health;

/**
 * Descobre o que está de pé.
 *
 * Nada aqui é obrigatório: sem Whisper a interface volta a ouvir pelo
 * navegador, sem Piper ela fala com a voz do sistema. A conversa continua —
 * só perde qualidade.
 */
export async function checkVoice(): Promise<VoiceHealth> {
  const ping = async (url: string): Promise<boolean> => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      return response.ok;
    } catch {
      return false;
    }
  };

  const [stt, tts] = await Promise.all([
    ping(`${WHISPER}/docs`),
    ping(`${PIPER}/health`),
  ]);

  const changed = stt !== health.stt || tts !== health.tts;
  health = { stt, tts, checkedAt: Date.now() };
  if (changed) {
    console.log(`[voz] whisper: ${stt ? 'ok' : 'off'} · piper: ${tts ? 'ok' : 'off'}`);
  }
  return health;
}

/** Áudio → texto, em português, pelo Whisper local. */
export async function transcribe(audio: Buffer, filename = 'fala.webm'): Promise<string> {
  const form = new FormData();
  form.append('audio_file', new Blob([new Uint8Array(audio)]), filename);

  const url = `${WHISPER}/asr?encode=true&task=transcribe&language=pt&output=json`;
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Whisper respondeu ${response.status}`);

  const data = (await response.json()) as { text?: string };
  return (data.text ?? '').trim();
}

/** Texto → WAV, em pt-BR, pelo Piper local. */
export async function synthesize(text: string): Promise<Buffer> {
  const response = await fetch(`${PIPER}/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Piper respondeu ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Nome que acorda a ferramenta. Configurável porque é gosto pessoal. */
export const wakeWord = (process.env.VOICE_WAKE_WORD ?? 'ia coder').toLowerCase();

/**
 * A transcrição raramente é exata: "IA Coder" vira "ia códer", "ia corder",
 * "e a coder". Comparamos sem acento e aceitamos o começo da frase.
 */
export function matchesWake(text: string): { hit: boolean; rest: string } {
  const normal = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const wake = wakeWord
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();

  const variants = [wake, wake.replace(/\s+/g, ''), 'ia coder', 'ia corder', 'ia codar', 'jarvis'];
  for (const variant of variants) {
    const index = normal.indexOf(variant);
    if (index >= 0 && index <= 12) {
      return { hit: true, rest: text.slice(index + variant.length).replace(/^[\s,.:;!?-]+/, '') };
    }
  }
  return { hit: false, rest: text };
}

export const voiceConfig = {
  whisperUrl: WHISPER,
  piperUrl: PIPER,
  wakeWord,
  claudeBin: config.claude.bin,
};
