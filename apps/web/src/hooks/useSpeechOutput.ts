import { useCallback, useEffect, useRef, useState } from 'react';

interface SpeechOutput {
  supported: boolean;
  enabled: boolean;
  speaking: boolean;
  setEnabled: (value: boolean) => void;
  speak: (text: string) => void;
  cancel: () => void;
}

const STORAGE_KEY = 'iacoder.tts';

/** Resposta falada em pt-BR. Preferimos uma voz local do sistema quando existir. */
export function useSpeechOutput(lang = 'pt-BR'): SpeechOutput {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [enabled, setEnabledState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const [speaking, setSpeaking] = useState(false);
  const voice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (!supported) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      voice.current =
        voices.find((v) => v.lang.replace('_', '-') === lang && v.localService) ??
        voices.find((v) => v.lang.replace('_', '-').startsWith(lang.slice(0, 2))) ??
        null;
    };
    pick();
    window.speechSynthesis.addEventListener('voiceschanged', pick);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pick);
  }, [supported, lang]);

  const setEnabled = useCallback(
    (value: boolean) => {
      setEnabledState(value);
      try {
        localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
      } catch {
        /* modo privado: segue sem persistir */
      }
      if (!value && supported) window.speechSynthesis.cancel();
    },
    [supported],
  );

  const speak = useCallback(
    (text: string) => {
      if (!supported || !enabled || !text.trim()) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = 1.05;
      if (voice.current) utterance.voice = voice.current;
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
    },
    [supported, enabled, lang],
  );

  const cancel = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  useEffect(() => () => cancel(), [cancel]);

  return { supported, enabled, speaking, setEnabled, speak, cancel };
}
