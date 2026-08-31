import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * Nível real do microfone (0..1) por banda, para desenhar o waveform.
 * Só abre o microfone enquanto `active` é true e devolve tudo ao parar.
 * Se a permissão for negada, o waveform cai para um padrão sintético — a UI não quebra.
 */
export function useMicLevel(active: boolean, bands: number): MutableRefObject<Float32Array> {
  const levels = useRef<Float32Array>(new Float32Array(bands));

  useEffect(() => {
    if (levels.current.length !== bands) levels.current = new Float32Array(bands);
  }, [bands]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    let cancelled = false;

    const decay = () => {
      for (let i = 0; i < levels.current.length; i += 1) levels.current[i] *= 0.82;
    };

    if (!active) {
      decay();
      return;
    }

    const synthetic = () => {
      const t = performance.now() / 170;
      for (let i = 0; i < levels.current.length; i += 1) {
        levels.current[i] = Math.abs(Math.sin(t + i * 0.42)) * (0.35 + Math.random() * 0.5);
      }
      frame = requestAnimationFrame(synthetic);
    };

    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((granted) => {
        if (cancelled) {
          granted.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = granted;
        context = new AudioContext();
        const source = context.createMediaStreamSource(granted);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);

        const spectrum = new Uint8Array(analyser.frequencyBinCount);
        const step = Math.floor(spectrum.length / levels.current.length) || 1;

        const tick = () => {
          analyser.getByteFrequencyData(spectrum);
          for (let i = 0; i < levels.current.length; i += 1) {
            let sum = 0;
            for (let j = 0; j < step; j += 1) sum += spectrum[i * step + j] ?? 0;
            levels.current[i] = sum / step / 255;
          }
          frame = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {
        if (!cancelled) synthetic();
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      decay();
    };
  }, [active, bands]);

  return levels;
}
