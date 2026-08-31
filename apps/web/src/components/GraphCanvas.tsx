import { useEffect, useRef, useState } from 'react';
import styles from './Panels.module.css';

export interface GraphNode {
  id: string;
  label: string;
  color: string;
  /** Raio base do círculo. */
  size?: number;
  /** Linha extra no tooltip. */
  hint?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

interface Body extends GraphNode {
  x: number; y: number; vx: number; vy: number;
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onSelect?: (id: string) => void;
  empty?: string;
}

/**
 * Grafo de forças em canvas, usado nos dois níveis do Tree.
 *
 * Roda inteiro fora do React: a simulação escreve direto no canvas, então
 * nenhum quadro dispara render. Só o tooltip é estado.
 */
export function GraphCanvas({ nodes, edges, onSelect, empty }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodies = useRef<Body[]>([]);
  const hovered = useRef<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const previous = new Map(bodies.current.map((body) => [body.id, body]));
    bodies.current = nodes.map((node, index) => {
      const old = previous.get(node.id);
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
      return {
        ...node,
        x: old?.x ?? 130 + Math.cos(angle) * 60,
        y: old?.y ?? 100 + Math.sin(angle) * 50,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
      };
    });
  }, [nodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let frame = 0;
    const paint = (): void => {
      const width = canvas.width / devicePixelRatio;
      const height = canvas.height / devicePixelRatio;
      simulate(bodies.current, edges, width, height);
      render(ctx, bodies.current, edges, width, height, hovered.current);
    };
    const resize = (): void => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      canvas.width = rect.width * devicePixelRatio;
      canvas.height = rect.height * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      paint();
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    const loop = (): void => {
      paint();
      frame = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [edges]);

  const hit = (event: React.MouseEvent<HTMLCanvasElement>): Body | undefined => {
    const rect = event.currentTarget.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    return bodies.current.find(
      (body) => Math.hypot(body.x - mx, body.y - my) < (body.size ?? 6) + 8,
    );
  };

  return (
    <div className={styles.treeWrap}>
      <canvas
        ref={canvasRef}
        className={styles.treeCanvas}
        style={{ cursor: onSelect && hovered.current ? 'pointer' : 'default' }}
        onMouseMove={(event) => {
          const found = hit(event);
          hovered.current = found?.id ?? null;
          if (found) {
            const rect = event.currentTarget.getBoundingClientRect();
            setTip({
              x: event.clientX - rect.left + 12,
              y: event.clientY - rect.top - 6,
              text: found.hint ? `${found.label} · ${found.hint}` : found.label,
            });
          } else {
            setTip(null);
          }
        }}
        onMouseLeave={() => {
          hovered.current = null;
          setTip(null);
        }}
        onClick={(event) => {
          const found = hit(event);
          if (found && onSelect) onSelect(found.id);
        }}
      />
      <div
        className={[styles.treeTip, tip ? styles.treeTipVisible : ''].filter(Boolean).join(' ')}
        style={{ left: tip?.x ?? 0, top: tip?.y ?? 0 }}
      >
        {tip?.text}
      </div>
      {nodes.length === 0 && empty && <p className={styles.graphEmpty}>{empty}</p>}
    </div>
  );
}

/* ------------------------------------------------------------- simulação -- */

function simulate(bodies: Body[], edges: GraphEdge[], width: number, height: number): void {
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const a = bodies[i];
      const b = bodies[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const force = 760 / (distance * distance);
      dx /= distance;
      dy /= distance;
      a.vx -= dx * force;
      a.vy -= dy * force;
      b.vx += dx * force;
      b.vy += dy * force;
    }
  }

  const index = new Map(bodies.map((body) => [body.id, body]));
  edges.forEach((edge) => {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (!a || !b) return;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    const force = (distance - 66) * 0.006;
    dx /= distance;
    dy /= distance;
    a.vx += dx * force;
    a.vy += dy * force;
    b.vx -= dx * force;
    b.vy -= dy * force;
  });

  bodies.forEach((body) => {
    body.vx += (width / 2 - body.x) * 0.0016;
    body.vy += (height / 2 - body.y) * 0.0016;
    body.vx *= 0.86;
    body.vy *= 0.86;
    body.x = Math.max(18, Math.min(width - 18, body.x + body.vx));
    body.y = Math.max(16, Math.min(height - 18, body.y + body.vy));
  });
}

function render(
  ctx: CanvasRenderingContext2D,
  bodies: Body[],
  edges: GraphEdge[],
  width: number,
  height: number,
  hovered: string | null,
): void {
  ctx.clearRect(0, 0, width, height);
  const index = new Map(bodies.map((body) => [body.id, body]));
  const time = performance.now() / 1000;

  edges.forEach((edge, k) => {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (!a || !b) return;
    const lit = hovered === edge.from || hovered === edge.to;

    ctx.strokeStyle = lit ? 'rgba(160,235,255,.8)' : 'rgba(120,190,255,.18)';
    ctx.lineWidth = lit ? 1.5 : 0.9;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // Pulso indicando o sentido da relação.
    const t = (time * 0.3 + k * 0.13) % 1;
    ctx.fillStyle = lit ? 'rgba(200,248,255,.95)' : 'rgba(140,220,255,.4)';
    ctx.beginPath();
    ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, lit ? 2 : 1.3, 0, Math.PI * 2);
    ctx.fill();

    if (lit && edge.label) {
      ctx.font = '8px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#cdefff';
      ctx.fillText(edge.label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 5);
    }
  });

  bodies.forEach((body) => {
    const lit = hovered === body.id;
    const radius = body.size ?? 6;

    ctx.globalAlpha = lit ? 1 : 0.88;
    ctx.fillStyle = body.color;
    ctx.beginPath();
    ctx.arc(body.x, body.y, radius + (lit ? 2.5 : 0), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.shadowColor = body.color;
    ctx.shadowBlur = lit ? 20 : 9;
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath();
    ctx.arc(body.x, body.y, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.font = '8.5px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = lit ? '#eaf9ff' : 'rgba(190,215,235,.6)';
    ctx.fillText(trim(body.label), body.x, body.y + radius + 11);
  });
}

const trim = (label: string): string => (label.length > 18 ? `${label.slice(0, 17)}…` : label);
