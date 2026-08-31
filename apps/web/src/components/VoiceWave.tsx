import { useEffect, useRef } from 'react';
import { useMicLevel } from '@/hooks/useMicLevel';
import styles from './PromptBox.module.css';

const BANDS = 28;

/** Waveform ligado ao microfone real. Sem permissão, cai para um padrão sintético. */
export function VoiceWave({ active }: { active: boolean }) {
  const levels = useMicLevel(active, BANDS);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const paint = () => {
      const bars = container.current?.children;
      if (bars) {
        for (let i = 0; i < bars.length; i += 1) {
          const level = levels.current[i] ?? 0;
          const height = 5 + level * (active ? 34 : 10);
          (bars[i] as HTMLElement).style.height = `${height.toFixed(1)}px`;
        }
      }
      frame = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(frame);
  }, [levels, active]);

  return (
    <div ref={container} style={{ display: 'contents' }}>
      {Array.from({ length: BANDS }, (_, index) => (
        <i key={index} className={styles.bar} />
      ))}
    </div>
  );
}
