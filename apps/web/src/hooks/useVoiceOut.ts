import { useCallback, useRef, useState } from 'react';

export type VoiceSource = 'piper' | 'navegador' | 'mudo';

/**
 * As vozes do navegador chegam em duas etapas.
 *
 * `getVoices()` devolve lista vazia até o motor terminar de carregar, e falar
 * nesse intervalo simplesmente **não produz som** — sem erro, sem aviso. Por
 * isso esperamos as vozes antes da primeira fala.
 */
function loadVoices(timeoutMs = 3000): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve([]);

    const ready = window.speechSynthesis.getVoices();
    if (ready.length > 0) return resolve(ready);

    const done = (): void => {
      window.speechSynthesis.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(window.speechSynthesis.getVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    window.speechSynthesis.addEventListener('voiceschanged', done);
  });
}

/**
 * Fala do agente.
 *
 * Prefere o Piper local (voz pt-BR de verdade, roda no seu Docker). Sem ele,
 * cai para a voz do sistema pelo navegador. Se nem isso houver, avisa em vez
 * de ficar mudo em silêncio — ficar sem som e sem explicação é o pior caso.
 *
 * `onBoundary` avisa quando a fala começa e termina, para o microfone fechar e
 * o agente não se ouvir.
 */
export function useVoiceOut(onBoundary?: (speaking: boolean) => void) {
  const [speaking, setSpeaking] = useState(false);
  const [source, setSource] = useState<VoiceSource>('piper');
  const [error, setError] = useState<string | null>(null);

  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const watchdog = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    if (watchdog.current) window.clearTimeout(watchdog.current);
    watchdog.current = null;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setSpeaking(false);
    onBoundary?.(false);
  }, [onBoundary]);

  const fallback = useCallback(
    async (text: string) => {
      if (!('speechSynthesis' in window)) {
        setSource('mudo');
        setError('este navegador não tem síntese de voz');
        return cleanup();
      }

      const voices = await loadVoices();
      if (voices.length === 0) {
        setSource('mudo');
        setError('nenhuma voz instalada no sistema');
        return cleanup();
      }

      const voice =
        voices.find((item) => /pt[-_]BR/i.test(item.lang)) ??
        voices.find((item) => /^pt/i.test(item.lang)) ??
        null;

      setSource('navegador');
      if (!voice) setError('sem voz em português — usando a voz padrão do sistema');

      const utterance = new SpeechSynthesisUtterance(text);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = 1.05;
      utterance.onend = cleanup;
      utterance.onerror = (event) => {
        // "interrupted" e "canceled" são normais quando cortamos uma fala.
        if (event.error !== 'interrupted' && event.error !== 'canceled') {
          setError(`falha ao falar: ${event.error}`);
        }
        cleanup();
      };

      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    },
    [cleanup],
  );

  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setSpeaking(true);
      setError(null);
      onBoundary?.(true);

      // O `onend` do speechSynthesis some quando a fala é cancelada — e aí o
      // microfone ficaria fechado para sempre. Este relógio garante a volta.
      if (watchdog.current) window.clearTimeout(watchdog.current);
      watchdog.current = window.setTimeout(cleanup, 5000 + text.length * 90);

      try {
        const response = await fetch('/voice/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw new Error(String(response.status));

        const blob = await response.blob();
        if (blob.size < 128) throw new Error('áudio vazio');

        url.current = URL.createObjectURL(blob);
        const player = new Audio(url.current);
        audio.current = player;
        player.onended = cleanup;
        player.onerror = () => void fallback(text);
        setSource('piper');
        await player.play();
      } catch {
        // Piper fora do ar (ou sem o perfil "voice" no Docker): voz do sistema.
        await fallback(text);
      }
    },
    [cleanup, fallback, onBoundary],
  );

  const stop = useCallback(() => {
    audio.current?.pause();
    window.speechSynthesis?.cancel();
    cleanup();
  }, [cleanup]);

  return { speak, stop, speaking, source, error };
}
