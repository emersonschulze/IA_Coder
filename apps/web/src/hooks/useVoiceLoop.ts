import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

interface Options {
  /** Enquanto true, o microfone fica aberto esperando você falar. */
  active: boolean;
  /** Chamado com o áudio de cada fala terminada. */
  onUtterance: (audio: Blob) => void;
  onError?: (message: string) => void;
}

interface VoiceLoop {
  /** 0..1 — para desenhar o waveform. */
  levelRef: MutableRefObject<number>;
  speaking: boolean;
  ready: boolean;
  /** Fecha o microfone enquanto o agente fala, para ele não se ouvir. */
  setMuted: (muted: boolean) => void;
}

/** Acima disso é fala; abaixo, silêncio. Calibrado para microfone de notebook. */
const SPEECH_LEVEL = 0.045;
/**
 * Silêncio contínuo que encerra a fala — é o "Enter" da conversa por voz.
 * Curto demais corta você no meio da frase; longo demais parece travado.
 * 1,5s foi o equilíbrio; mexa aqui se quiser mais folga para pensar.
 */
const SILENCE_MS = 1500;
/** Ruído curto (tosse, clique de mouse) não vira pedido. */
const MIN_SPEECH_MS = 400;

/**
 * Escuta sem mãos.
 *
 * Em vez de mandar tudo para a nuvem para descobrir quando você parou de falar,
 * medimos o volume aqui mesmo: sobe do limiar, começa a gravar; passou quase um
 * segundo em silêncio, fecha a gravação e manda o trecho para o Whisper local.
 * Só o áudio da fala sai do navegador — e sai para a sua própria máquina.
 */
export function useVoiceLoop({ active, onUtterance, onError }: Options): VoiceLoop {
  const levelRef = useRef(0);
  const mutedRef = useRef(false);
  const [speaking, setSpeaking] = useState(false);
  const [ready, setReady] = useState(false);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);

  const setMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
  }, []);

  useEffect(() => {
    if (!active) {
      setReady(false);
      levelRef.current = 0;
      return;
    }

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    let cancelled = false;
    let silenceSince = 0;

    const stopUtterance = (): void => {
      const active_ = recorder.current;
      if (!active_ || active_.state !== 'recording') return;
      active_.stop();
      setSpeaking(false);
    };

    const beginUtterance = (): void => {
      if (!stream || recorder.current?.state === 'recording') return;
      chunks.current = [];
      startedAt.current = performance.now();

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const instance = new MediaRecorder(stream, { mimeType: mime });

      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      instance.onstop = () => {
        const duration = performance.now() - startedAt.current;
        const blob = new Blob(chunks.current, { type: mime });
        chunks.current = [];
        // Tosse, clique de mouse e "ãhn" não viram pedido.
        if (duration >= MIN_SPEECH_MS && blob.size > 2000) onUtterance(blob);
      };

      instance.start(200);
      recorder.current = instance;
      setSpeaking(true);
    };

    navigator.mediaDevices
      ?.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      .then((granted) => {
        if (cancelled) {
          granted.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = granted;
        context = new AudioContext();
        const source = context.createMediaStreamSource(granted);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        setReady(true);

        const samples = new Float32Array(analyser.fftSize);
        const tick = (): void => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
          const level = Math.sqrt(sum / samples.length);
          levelRef.current = mutedRef.current ? 0 : level;

          if (!mutedRef.current) {
            const loud = level > SPEECH_LEVEL;
            if (loud) {
              silenceSince = 0;
              beginUtterance();
            } else if (recorder.current?.state === 'recording') {
              if (silenceSince === 0) silenceSince = performance.now();
              else if (performance.now() - silenceSince > SILENCE_MS) {
                silenceSince = 0;
                stopUtterance();
              }
            }
          }
          frame = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch((error: Error) => {
        if (!cancelled) onError?.(error.message);
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stopUtterance();
      recorder.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      setReady(false);
    };
  }, [active, onUtterance, onError]);

  return { levelRef, speaking, ready, setMuted };
}
