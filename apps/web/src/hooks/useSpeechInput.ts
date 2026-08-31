import { useCallback, useEffect, useRef, useState } from 'react';

/* A Web Speech API não tem tipos no lib.dom padrão; declaramos o mínimo que usamos. */
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  0: SpeechRecognitionAlternative;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getConstructor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface Options {
  lang?: string;
  /** Chamado a cada atualização (parcial ou final) do que foi ouvido. */
  onTranscript: (text: string, isFinal: boolean) => void;
}

interface SpeechInput {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

/** Ditado contínuo em pt-BR. O texto vai direto para a caixa de comando. */
export function useSpeechInput({ lang = 'pt-BR', onTranscript }: Options): SpeechInput {
  const [supported] = useState(() => getConstructor() !== null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const wanted = useRef(false);
  const callback = useRef(onTranscript);
  callback.current = onTranscript;

  useEffect(() => {
    const Ctor = getConstructor();
    if (!Ctor) return;

    const instance = new Ctor();
    instance.lang = lang;
    instance.continuous = true;
    instance.interimResults = true;

    instance.onresult = (event) => {
      let text = '';
      let isFinal = false;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript;
        isFinal = event.results[i].isFinal;
      }
      callback.current(text, isFinal);
    };

    instance.onerror = (event) => {
      setError(event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        wanted.current = false;
        setListening(false);
      }
    };

    // Chrome encerra sozinho após alguns segundos de silêncio: religamos se o usuário ainda quer.
    instance.onend = () => {
      if (wanted.current) {
        try {
          instance.start();
          return;
        } catch {
          /* ignora corrida de start/stop */
        }
      }
      setListening(false);
    };

    recognition.current = instance;
    return () => {
      wanted.current = false;
      instance.onend = null;
      instance.abort();
      recognition.current = null;
    };
  }, [lang]);

  const start = useCallback(() => {
    if (!recognition.current || wanted.current) return;
    setError(null);
    wanted.current = true;
    try {
      recognition.current.start();
      setListening(true);
    } catch {
      wanted.current = false;
    }
  }, []);

  const stop = useCallback(() => {
    if (!recognition.current) return;
    wanted.current = false;
    recognition.current.stop();
    setListening(false);
  }, []);

  const toggle = useCallback(() => (wanted.current ? stop() : start()), [start, stop]);

  return { supported, listening, error, start, stop, toggle };
}
