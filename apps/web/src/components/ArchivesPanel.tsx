import { useAnchor } from '@/anchors/AnchorContext';
import { useSession } from '@/store/useSession';
import type { Artifact } from '@/types/domain';
import { Panel, PanelBody, PanelEmpty } from './Panel';
import styles from './Panels.module.css';

const ICONS: Record<string, string> = {
  md: '📄',
  markdown: '📄',
  png: '🖼️',
  jpg: '🖼️',
  image: '🖼️',
  pptx: '📊',
  deck: '📊',
  xlsx: '📈',
  json: '🗂️',
  code: '🧩',
  pdf: '📕',
};

/** Só o conteúdo, sem a casca do painel — usado sozinho e dentro do painel com abas. */
export function ArchivesBody() {
  const archives = useSession((state) => state.archives);

  return (
    <PanelBody>
      {archives.length === 0 ? (
        <PanelEmpty>nenhum artefato gerado nesta sessão</PanelEmpty>
      ) : (
        archives.map((artifact) => <ArchiveRow key={artifact.id} artifact={artifact} />)
      )}
    </PanelBody>
  );
}

/** Painel avulso — hoje só usado se algum dia o Archives voltar a ficar sozinho. */
export function ArchivesPanel() {
  const count = useSession((state) => state.archives.length);
  return (
    <Panel
      title="Archives"
      badge={`${count} artefato${count === 1 ? '' : 's'}`}
      zoomable
      style={{ flex: '0 0 auto', maxHeight: 206 }}
    >
      <ArchivesBody />
    </Panel>
  );
}

function ArchiveRow({ artifact }: { artifact: Artifact }) {
  const anchorRef = useAnchor('archive', artifact.id);
  const icon = ICONS[artifact.kind.toLowerCase()] ?? '📎';

  return (
    <button
      ref={anchorRef}
      type="button"
      className={styles.archive}
      title={artifact.href ?? artifact.name}
      onClick={() => artifact.href && window.open(artifact.href, '_blank', 'noopener')}
    >
      <span className={styles.archiveIcon}>{icon}</span>
      <span className={styles.archiveName}>{artifact.name}</span>
      <span className={styles.archiveTime}>{relative(artifact.createdAt)}</span>
    </button>
  );
}

function relative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
