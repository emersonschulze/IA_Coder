import { usePrefs } from '@/store/usePrefs';
import styles from './Panels.module.css';

/**
 * Alterna entre lista estável e "ativos no topo".
 *
 * Existe como opção, e não como comportamento fixo, porque a resposta certa
 * depende do tamanho da lista: com 4 agentes a ordem estável ganha (a memória
 * de posição vale mais que a promoção); com 20 skills, subir o que está em uso
 * evita caçar o card fora da rolagem.
 */
export function PinToggle() {
  const pinActive = usePrefs((state) => state.pinActive);
  const setPinActive = usePrefs((state) => state.setPinActive);

  return (
    <button
      type="button"
      className={[styles.headAction, pinActive ? styles.headActionOn : ''].filter(Boolean).join(' ')}
      onClick={() => setPinActive(!pinActive)}
      title={
        pinActive
          ? 'Ativos no topo — clique para manter a ordem fixa'
          : 'Ordem fixa — clique para trazer os ativos para o topo'
      }
      aria-pressed={pinActive}
    >
      {pinActive ? '\u2191\u25AA' : '\u25AB\u25AB'}
    </button>
  );
}
