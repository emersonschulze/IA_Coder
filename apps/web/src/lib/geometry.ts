export interface Point {
  x: number;
  y: number;
}

const centerY = (r: DOMRect) => r.top + r.height / 2;
const centerX = (r: DOMRect) => r.left + r.width / 2;

/**
 * Decide sozinho por onde a seta sai e entra, e devolve o path SVG.
 *
 * - alvo à direita  → sai pela direita, entra pela esquerda (bézier horizontal)
 * - alvo à esquerda → espelhado
 * - mesma coluna    → arco lateral saindo por baixo/cima, contornando os cards
 */
export function wirePath(from: DOMRect, to: DOMRect): string {
  const gap = 24;

  if (to.left > from.right + gap) {
    const a: Point = { x: from.right, y: centerY(from) };
    const b: Point = { x: to.left, y: centerY(to) };
    return horizontal(a, b);
  }

  if (to.right < from.left - gap) {
    const a: Point = { x: from.left, y: centerY(from) };
    const b: Point = { x: to.right, y: centerY(to) };
    return horizontal(a, b);
  }

  const goingDown = centerY(to) >= centerY(from);
  const a: Point = { x: centerX(from), y: goingDown ? from.bottom : from.top };
  const b: Point = { x: centerX(to), y: goingDown ? to.top : to.bottom };
  // O arco contorna a coluna pela esquerda, mas nunca sai da janela.
  const bow = Math.max(14, Math.min(from.left, to.left) - 34);
  return arc(a, b, bow);
}

function horizontal(a: Point, b: Point): string {
  const k = Math.min(Math.abs(b.x - a.x) * 0.55, 190);
  const dir = b.x >= a.x ? 1 : -1;
  return `M${r(a.x)},${r(a.y)} C${r(a.x + k * dir)},${r(a.y)} ${r(b.x - k * dir)},${r(b.y)} ${r(b.x)},${r(b.y)}`;
}

function arc(a: Point, b: Point, controlX: number): string {
  const dy = b.y - a.y;
  return `M${r(a.x)},${r(a.y)} C${r(controlX)},${r(a.y + dy * 0.18)} ${r(controlX)},${r(b.y - dy * 0.3)} ${r(b.x)},${r(b.y)}`;
}

const r = (n: number) => Math.round(n * 100) / 100;

/** Ponta de seta posicionada no fim do path. */
export function arrowTransform(path: SVGPathElement): string {
  const length = path.getTotalLength();
  if (!Number.isFinite(length) || length === 0) return '';
  const end = path.getPointAtLength(length);
  const before = path.getPointAtLength(Math.max(0, length - 6));
  const angle = (Math.atan2(end.y - before.y, end.x - before.x) * 180) / Math.PI;
  return `translate(${end.x},${end.y}) rotate(${angle})`;
}

export function pointAt(path: SVGPathElement, t: number): Point {
  const length = path.getTotalLength();
  const p = path.getPointAtLength(length * t);
  return { x: p.x, y: p.y };
}
