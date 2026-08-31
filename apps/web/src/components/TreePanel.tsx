import { useEffect, useMemo, useState } from 'react';
import { useSession } from '@/store/useSession';
import type { ComponentKind } from '@/types/domain';
import { GraphCanvas, type GraphEdge, type GraphNode } from './GraphCanvas';
import { Panel } from './Panel';
import styles from './Panels.module.css';

interface Props {
  onList: () => void;
  onOpen: (subjectId: string) => void;
}

/** Cada tipo de peça da stack tem sua cor — dá para ler o desenho sem legenda. */
const KIND_COLOR: Record<ComponentKind, string> = {
  microfrontend: '#a855f7',
  microservice: '#22d3ee',
  api: '#38bdf8',
  database: '#34d399',
  cache: '#fb7185',
  queue: '#fbbf24',
  job: '#f59e0b',
  external: '#94a3b8',
  library: '#818cf8',
  infra: '#64748b',
};

const STATUS_BADGE: Record<string, string> = {
  connecting: 'conectando…',
  unreachable: 'banco offline',
  'schema-missing': 'falta migração',
};

/**
 * Quando o Tree está vazio, o motivo importa mais que o vazio. Cada estado tem
 * a sua saída — e nenhum deles pede para reiniciar o servidor, porque ele
 * reconecta sozinho a cada 10 segundos.
 */
const STATUS_MESSAGE: Record<string, string> = {
  connecting: 'procurando o banco…',
  unreachable:
    'o Postgres não respondeu. Suba com “docker compose up -d” — o Tree acende sozinho em até 10s, sem reiniciar nada.',
  'schema-missing':
    'o banco está de pé, mas foi criado antes do Tree de dois níveis. Aplique a migração:\ndocker exec -i ia_coder_postgres psql -U iacoder -d iacoder < db/migrations/001_tree_dois_niveis.sql',
};

/**
 * O Tree em dois níveis.
 *
 * Nível 1: os assuntos já confirmados e como conversam entre si.
 * Clicou num assunto → nível 2: quais micro frontends, serviços, bancos e
 * caches participam daquela demanda, e como se ligam.
 */
export function TreePanel({ onList, onOpen }: Props) {
  const graph = useSession((state) => state.tree);
  const status = useSession((state) => state.treeStatus);
  const detail = useSession((state) => state.treeDetail);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    onList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const level1 = useMemo(() => {
    const nodes: GraphNode[] = graph.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      color: node.hits > 0 ? '#22d3ee' : '#7dd3fc',
      size: 6 + Math.min(6, node.components * 0.8),
      hint: `${node.components} serviços · ${node.hits} reusos`,
    }));
    const edges: GraphEdge[] = graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.kind,
    }));
    return { nodes, edges };
  }, [graph]);

  const level2 = useMemo(() => {
    if (!detail) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    return {
      nodes: detail.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        color: KIND_COLOR[node.kind] ?? '#94a3b8',
        size: 7,
        hint: node.detail ? `${node.kind} · ${node.detail}` : node.kind,
      })),
      edges: detail.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label ?? edge.kind,
      })),
    };
  }, [detail]);

  const openSubject = (id: string): void => {
    setOpenId(id);
    onOpen(id);
  };

  const inDetail = openId !== null && detail !== null;
  const badge = inDetail
    ? `${detail.nodes.length} serviços`
    : status === 'ok'
      ? `${graph.nodes.length} assuntos`
      : STATUS_BADGE[status];

  return (
    <Panel
      title="Tree"
      badge={badge}
      zoomable
      action={
        inDetail ? (
          <button
            type="button"
            className={styles.headAction}
            onClick={() => setOpenId(null)}
            title="Voltar para os assuntos"
          >
            ←
          </button>
        ) : undefined
      }
      style={{ flex: '1 1 0px', minHeight: 220 }}
    >
      {inDetail && (
        <div className={styles.treeCrumb}>
          <button type="button" className={styles.crumbLink} onClick={() => setOpenId(null)}>
            assuntos
          </button>
          <span>›</span>
          <strong title={detail.subject.summary}>{detail.subject.label}</strong>
        </div>
      )}

      {inDetail ? (
        <GraphCanvas
          nodes={level2.nodes}
          edges={level2.edges}
          empty="este assunto ainda não tem stack mapeada"
        />
      ) : (
        <GraphCanvas
          nodes={level1.nodes}
          edges={level1.edges}
          onSelect={openSubject}
          empty={
            status === 'ok'
              ? 'nenhum assunto guardado ainda — termine uma análise e clique em “Guardar no Tree”'
              : STATUS_MESSAGE[status]
          }
        />
      )}
    </Panel>
  );
}
