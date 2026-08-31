const URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.EMBEDDINGS_MODEL ?? 'nomic-embed-text';
const ENABLED = (process.env.EMBEDDINGS_PROVIDER ?? 'ollama') !== 'none';

let warned = false;

/**
 * Embedding de um texto via Ollama local.
 *
 * Devolve `null` quando o Ollama não está de pé — e isso não é erro: o Tree
 * cai para busca por texto (pg_trgm), que é pior mas continua encontrando
 * assunto por palavra. O que não pode é a ferramenta parar por causa disso.
 */
export async function embed(text: string): Promise<number[] | null> {
  if (!ENABLED || !text.trim()) return null;
  try {
    const response = await fetch(`${URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { embedding?: number[] };
    return Array.isArray(data.embedding) && data.embedding.length > 0 ? data.embedding : null;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(`[embeddings] Ollama indisponível (${(error as Error).message}) — busca por texto`);
    }
    return null;
  }
}

/** pgvector recebe o vetor no formato '[0.1,0.2,…]'. */
export const toVector = (values: number[]): string => `[${values.join(',')}]`;
