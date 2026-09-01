import { Fragment, type ReactNode } from 'react';
import styles from './BubbleText.module.css';

/**
 * O texto de uma bolha do Talking, com a marcação que o agente usa de verdade.
 *
 * Não é um renderizador de Markdown, e não deve virar um. O agente escreve em
 * prosa com três coisas recorrentes — negrito, `código` e bloco cercado — e era
 * só isso que aparecia cru na tela, do jeito que ele digitou: "foi
 * **bloqueada**" com os asteriscos à mostra. Título, tabela e link viram texto
 * comum de propósito: numa bolha de conversa eles não acrescentam nada, e cada
 * regra a mais é uma chance a mais de estragar um trecho de código que só
 * queria ser lido como está.
 *
 * Lista continua sendo `- item` literal, e fica bom: a bolha preserva quebra de
 * linha, então a lista já se lê como lista sem precisar virar `<ul>`.
 */
export function BubbleText({ text }: { text: string }) {
  return <>{blocks(text).map((block, index) => <Fragment key={index}>{block}</Fragment>)}</>;
}

/** Quebra o texto em trechos normais e blocos cercados por ```. */
function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) out.push(<span>{inline(text.slice(last, match.index))}</span>);
    out.push(
      <pre className={styles.code}>
        <code>{match[2].replace(/\n$/, '')}</code>
      </pre>,
    );
    last = fence.lastIndex;
  }
  // Cerca aberta e nunca fechada — acontece com resposta interrompida. O resto
  // vai como texto: engolir seria perder justamente o final que faltava.
  if (last < text.length) out.push(<span>{inline(text.slice(last))}</span>);
  return out;
}

/** `**negrito**` e `código`, na ordem em que aparecem. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`\n]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(
      match[1] !== undefined
        ? <strong key={key++}>{match[1]}</strong>
        : <code key={key++} className={styles.inlineCode}>{match[2]}</code>,
    );
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
