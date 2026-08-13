const OPENAI = "https://api.openai.com/v1";
const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536 dims
const CHAT_MODEL = "gpt-4o-mini";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (first) {
    console.error(`[rag] ${label} failed, retrying once:`, first);
    await sleep(1500);
    try {
      return await fn();
    } catch (second) {
      console.error(`[rag] ${label} failed after retry:`, second);
      throw new Error(`${label} failed: ${(second as Error).message}`);
    }
  }
}

function aiKey(): string {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("Missing LOVABLE_API_KEY");
  return key;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return withRetry(async () => {
    const res = await fetch(`${GATEWAY}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aiKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }, "embedding");
}

export async function generateAnswer(query: string, context: string[]): Promise<string> {
  return withRetry(async () => {
    const res = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aiKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Answer only using the provided context. If the answer isn't in the context, say 'I don't have enough information to answer that.'",
          },
          {
            role: "user",
            content: `Context:\n${context.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}\n\nQuestion: ${query}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message?.content ?? "";
  }, "generation");
}

/** Split text into ~200-word chunks with 30-word overlap. */
export function chunkText(text: string, size = 200, overlap = 30): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < words.length; i += step) {
    chunks.push(words.slice(i, i + size).join(" "));
    if (i + size >= words.length) break;
  }
  return chunks;
}

type HFRow = { row_idx: number; row: Record<string, unknown> };

/** Pull passage texts out of an arbitrary datasets-server row shape. */
function extractPassages(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (value: unknown, key: string) => {
    if (typeof value === "string") {
      if (/passage|text|context|document|content|answer/i.test(key) && value.trim().length > 40) {
        out.push(value.trim());
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, key));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k);
    }
  };
  for (const [k, v] of Object.entries(row)) visit(v, k);
  return out;
}

const DATASETS = [
  "https://datasets-server.huggingface.co/rows?dataset=ai4bharat/MSMARCO-XI&config=default&split=train&offset=0&length=100",
  // Fallback: the upstream English MS MARCO corpus, used when the translated
  // dataset's rows endpoint is unavailable.
  "https://datasets-server.huggingface.co/rows?dataset=microsoft/ms_marco&config=v1.1&split=train&offset=0&length=100",
];

export async function fetchDatasetRows(): Promise<{ rows: HFRow[]; errors: string[] }> {
  const errors: string[] = [];
  for (const url of DATASETS) {
    try {
      const rows = await withRetry(async () => {
        const res = await fetch(url);
        const json = (await res.json()) as { rows?: HFRow[]; error?: string };
        if (!res.ok || json.error || !json.rows?.length) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        return json.rows;
      }, "dataset fetch");
      return { rows, errors };
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  return { rows: [], errors };
}

export { extractPassages };
