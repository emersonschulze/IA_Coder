import { dbReady, query } from './db.js';
import { embed, toVector } from './embeddings.js';
import type { ComponentKind, SubjectDetail, SubjectGraph } from './protocol.js';

const VALID_KINDS: ComponentKind[] = [
  'microfrontend', 'microservice', 'api', 'database', 'cache',
  'queue', 'job', 'external', 'library', 'infra',
];

export interface ExtractedSubject {
  title: string;
  slug: string;
  summary: string;
  tags?: string[];
  components?: { key: string; name: string; kind: string; detail?: string }[];
  links?: { from: string; to: string; kind?: string; label?: string }[];
  related?: string[];
}

const slugify = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || `assunto-${Date.now().toString(36)}`;

/* --------------------------------------------------------------- leitura -- */

/** Nível 1: os assuntos e como eles conversam entre si. */
export async function subjectGraph(): Promise<SubjectGraph> {
  if (!dbReady()) return { nodes: [], edges: [] };
  try {
    return await readSubjectGraph();
  } catch (error) {
    // Um erro de SQL não pode virar promessa rejeitada sem dono: o evento
    // simplesmente não chegaria na tela e o painel ficaria mudo.
    console.error('[tree] não consegui ler os assuntos:', (error as Error).message);
    return { nodes: [], edges: [] };
  }
}

async function readSubjectGraph(): Promise<SubjectGraph> {
  const nodes = await query<{
    id: string; slug: string; title: string; summary: string;
    tags: string[]; hits: number; components: string;
  }>(`
    SELECT s.id, s.slug, s.title, s.summary, s.tags, s.hits,
           COUNT(c.id)::text AS components
    FROM subjects s
    LEFT JOIN components c ON c.subject_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
  `);

  const edges = await query<{ from: string; to: string; kind: string }>(
    `SELECT from_subject AS from, to_subject AS to, kind FROM subject_links`,
  );

  return {
    nodes: nodes.map((row) => ({
      id: row.id,
      slug: row.slug,
      label: row.title,
      summary: row.summary,
      tags: row.tags ?? [],
      hits: row.hits,
      components: Number(row.components),
    })),
    edges,
  };
}

/** Nível 2: a stack de um assunto e como os serviços se ligam. */
export async function subjectDetail(subjectId: string): Promise<SubjectDetail | null> {
  if (!dbReady()) return null;
  try {
    return await readSubjectDetail(subjectId);
  } catch (error) {
    console.error('[tree] não consegui abrir o assunto:', (error as Error).message);
    return null;
  }
}

async function readSubjectDetail(subjectId: string): Promise<SubjectDetail | null> {
  const [subject] = await query<{
    id: string; slug: string; title: string; summary: string; tags: string[]; hits: number;
  }>(`SELECT id, slug, title, summary, tags, hits FROM subjects WHERE id = $1`, [subjectId]);
  if (!subject) return null;

  const nodes = await query<{
    id: string; key: string; name: string; kind: ComponentKind; detail: string | null;
  }>(`SELECT id, key, name, kind, detail FROM components WHERE subject_id = $1 ORDER BY kind, name`,
    [subjectId]);

  const edges = await query<{ from: string; to: string; kind: string; label: string | null }>(`
    SELECT cl.from_component AS from, cl.to_component AS to, cl.kind, cl.label
    FROM component_links cl
    JOIN components c ON c.id = cl.from_component
    WHERE c.subject_id = $1
  `, [subjectId]);

  return {
    subject: {
      id: subject.id, slug: subject.slug, label: subject.title,
      summary: subject.summary, tags: subject.tags ?? [], hits: subject.hits,
      components: nodes.length,
    },
    nodes: nodes.map((row) => ({
      id: row.id, key: row.key, label: row.name, kind: row.kind, detail: row.detail ?? undefined,
    })),
    edges: edges.map((row) => ({ ...row, label: row.label ?? undefined })),
  };
}

/* ---------------------------------------------------------------- escrita -- */

export async function saveSubject(
  extracted: ExtractedSubject,
  meta: { projectPath: string; persona?: string },
): Promise<{ id: string; title: string } | null> {
  if (!dbReady()) return null;

  const slug = slugify(extracted.slug || extracted.title);
  const content = [extracted.title, extracted.summary, (extracted.tags ?? []).join(' ')].join('\n');
  const vector = await embed(content);

  const [subject] = await query<{ id: string; title: string }>(`
    INSERT INTO subjects (slug, title, summary, persona, project_path, tags, content, embedding)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      tags = EXCLUDED.tags,
      content = EXCLUDED.content,
      embedding = COALESCE(EXCLUDED.embedding, subjects.embedding)
    RETURNING id, title
  `, [
    slug, extracted.title.trim(), extracted.summary.trim(),
    meta.persona ?? null, meta.projectPath, extracted.tags ?? [],
    content, vector ? toVector(vector) : null,
  ]);
  if (!subject) return null;

  // Regravar um assunto substitui a stack dele — a análise nova é a que vale.
  await query(`DELETE FROM components WHERE subject_id = $1`, [subject.id]);

  const byKey = new Map<string, string>();
  for (const component of extracted.components ?? []) {
    if (!component.key || !component.name) continue;
    const kind = (VALID_KINDS as string[]).includes(component.kind)
      ? (component.kind as ComponentKind)
      : 'microservice';
    const [row] = await query<{ id: string }>(`
      INSERT INTO components (subject_id, key, name, kind, detail)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (subject_id, key) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind
      RETURNING id
    `, [subject.id, slugify(component.key), component.name, kind, component.detail ?? null]);
    if (row) byKey.set(slugify(component.key), row.id);
  }

  for (const link of extracted.links ?? []) {
    const from = byKey.get(slugify(link.from));
    const to = byKey.get(slugify(link.to));
    if (!from || !to || from === to) continue;
    await query(`
      INSERT INTO component_links (from_component, to_component, kind, label)
      VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
    `, [from, to, link.kind ?? 'calls', link.label ?? null]);
  }

  for (const relatedSlug of extracted.related ?? []) {
    const [other] = await query<{ id: string }>(`SELECT id FROM subjects WHERE slug = $1`,
      [slugify(relatedSlug)]);
    if (!other || other.id === subject.id) continue;
    await query(`
      INSERT INTO subject_links (from_subject, to_subject, kind)
      VALUES ($1, $2, 'relates') ON CONFLICT DO NOTHING
    `, [subject.id, other.id]);
  }

  return subject;
}

export async function forgetSubject(subjectId: string): Promise<void> {
  if (!dbReady()) return;
  await query(`DELETE FROM subjects WHERE id = $1`, [subjectId]);
}

/* ------------------------------------------------------------ recuperação -- */

export interface Recall {
  id: string; slug: string; title: string; summary: string; similarity: number;
}

/**
 * A economia de tokens acontece aqui: antes de mandar o pedido para o agente,
 * procuramos assuntos já confirmados que tratam do mesmo tema e mandamos o
 * resumo junto. Ele começa sabendo, em vez de investigar tudo de novo.
 */
export async function recall(prompt: string, k = 3): Promise<Recall[]> {
  if (!dbReady()) return [];
  const vector = await embed(prompt);
  const rows = vector
    ? await query<Recall>(`SELECT * FROM subject_search($1::vector, $2)`, [toVector(vector), k])
    : await query<Recall>(`SELECT * FROM subject_search_text($1, $2)`, [prompt, k]);

  const useful = rows.filter((row) => row.similarity > (vector ? 0.45 : 0.15));
  if (useful.length > 0) {
    await query(`UPDATE subjects SET hits = hits + 1 WHERE id = ANY($1::uuid[])`,
      [useful.map((row) => row.id)]);
  }
  return useful;
}

/** Bloco de contexto que vai grudado no pedido do usuário. */
export function recallBlock(items: Recall[]): string {
  if (items.length === 0) return '';
  const body = items
    .map((item) => `- **${item.title}**: ${item.summary}`)
    .join('\n');
  return [
    '<contexto-do-tree>',
    'Conhecimento já confirmado neste projeto. Use como ponto de partida e NÃO reinvestigue o que já está aqui:',
    body,
    '</contexto-do-tree>',
    '',
  ].join('\n');
}

/** Pergunta que mandamos ao agente para transformar a análise em assunto. */
export function extractionPrompt(existingSlugs: string[]): string {
  return [
    'Resuma a análise que acabamos de fazer como um "assunto" reutilizável.',
    'Responda SOMENTE com um JSON válido, sem texto antes ou depois, sem cercas de código, neste formato:',
    '{',
    '  "title": "nome curto do assunto",',
    '  "slug": "identificador-em-kebab-case",',
    '  "summary": "3 a 6 linhas com o que foi aprendido e as decisões tomadas",',
    '  "tags": ["palavra", "chave"],',
    '  "components": [{"key":"api-pedidos","name":"API Pedidos","kind":"microservice","detail":".NET 8"}],',
    '  "links": [{"from":"mf-checkout","to":"api-pedidos","kind":"calls","label":"POST /pedidos"}],',
    `  "related": [${existingSlugs.slice(0, 20).map((slug) => `"${slug}"`).join(', ')}]`,
    '}',
    '',
    'Regras:',
    '- "kind" só pode ser: microfrontend, microservice, api, database, cache, queue, job, external, library, infra.',
    '- "components" são os serviços, bancos e caches que participam DESTA demanda. Se não houver, use [].',
    '- "links" usam as chaves de "components".',
    '- "related" deve conter apenas slugs da lista acima que realmente se relacionam; caso contrário, [].',
  ].join('\n');
}

/** O agente às vezes embrulha o JSON em texto; pegamos o primeiro objeto válido. */
export function parseExtraction(text: string): ExtractedSubject | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as ExtractedSubject;
    if (!parsed.title || !parsed.summary) return null;
    return parsed;
  } catch {
    return null;
  }
}
