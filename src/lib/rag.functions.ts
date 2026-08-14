import { createServerFn } from "@tanstack/react-start";

export const ingestCorpus = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { fetchDatasetRows, extractPassages, chunkText, embedTexts, sleep } = await import(
    "./rag.server"
  );

  const errors: string[] = [];

  // Prevent accidental duplicate ingestion: skip when the corpus is already loaded.
  const { count: existing, error: countError } = await supabaseAdmin
    .from("chunks")
    .select("id", { count: "exact", head: true });
  if (countError) {
    return { rows_fetched: 0, chunks_created: 0, already_loaded: false, errors: [countError.message] };
  }
  if ((existing ?? 0) > 0) {
    return { rows_fetched: 0, chunks_created: existing ?? 0, already_loaded: true, errors };
  }

  const { rows, errors: fetchErrors } = await fetchDatasetRows();
  errors.push(...fetchErrors);

  if (rows.length === 0) {
    return { rows_fetched: 0, chunks_created: 0, already_loaded: false, errors };
  }

  type Pending = { text: string; source_doc_id: string };
  const pending: Pending[] = [];
  for (const item of rows) {
    const sourceId = String(
      (item.row["query_id"] as string | number | undefined) ?? item.row_idx,
    );
    for (const passage of extractPassages(item.row)) {
      for (const chunk of chunkText(passage)) {
        pending.push({ text: chunk, source_doc_id: sourceId });
      }
    }
  }

  let chunksCreated = 0;
  const batchSize = 32;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    try {
      const embeddings = await embedTexts(batch.map((b) => b.text));
      const { error } = await supabaseAdmin.from("chunks").insert(
        batch.map((b, idx) => ({
          text: b.text,
          source_doc_id: b.source_doc_id,
          embedding: JSON.stringify(embeddings[idx]),
        })),
      );
      if (error) throw new Error(error.message);
      chunksCreated += batch.length;
    } catch (error) {
      const { friendlyError } = await import("./rag.server");
      errors.push(friendlyError((error as Error).message));
    }
    // Small pause keeps the embeddings API from rate-limiting the batch loop.
    await sleep(250);
  }

  return {
    rows_fetched: rows.length,
    chunks_created: chunksCreated,
    already_loaded: false,
    errors,
  };
});

export const speechToText = createServerFn({ method: "POST" })
  .inputValidator((input: { audioBase64: string; mimeType?: string }) => {
    if (!input?.audioBase64) throw new Error("audioBase64 is required");
    return input;
  })
  .handler(async ({ data }) => {
    const { transcribe } = await import("./stt.server");
    try {
      return { transcript: await transcribe(data.audioBase64), error: null };
    } catch (error) {
      console.error("[stt]", error);
      const { friendlyError } = await import("./rag.server");
      return { transcript: "", error: friendlyError((error as Error).message) };
    }
  });

export const ragAnswer = createServerFn({ method: "POST" })
  .inputValidator((input: { query: string; sttMs?: number }) => {
    if (!input?.query?.trim()) throw new Error("query is required");
    return input;
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { embedTexts, generateAnswer, friendlyError } = await import("./rag.server");

    const started = Date.now();
    let errorHint: string | null = null;
    try {
      const embeddingStart = Date.now();
      const [queryEmbedding] = await embedTexts([data.query]);
      const embeddingMs = Date.now() - embeddingStart;

      const retrievalStart = Date.now();
      const { data: matches, error } = await supabaseAdmin.rpc("match_chunks", {
        query_embedding: JSON.stringify(queryEmbedding),
        match_count: 5,
      });
      if (error) throw new Error(error.message);
      const retrievalMs = Date.now() - retrievalStart;

      const sources = (matches ?? []).map((m: { text: string }) => m.text);
      if (sources.length === 0) {
        errorHint = "No passages found — click Load Data first.";
      }

      const generationStart = Date.now();
      const answer = sources.length
        ? await generateAnswer(data.query, sources)
        : "I don't have enough information to answer that.";
      const generationMs = Date.now() - generationStart;

      const sttMs = data.sttMs ?? 0;
      const totalMs = Date.now() - started + sttMs;

      await supabaseAdmin.from("latency_logs").insert({
        query_text: data.query,
        stt_ms: sttMs,
        retrieval_ms: retrievalMs,
        generation_ms: generationMs,
        total_ms: totalMs,
      });

      return {
        answer,
        sources,
        latency: {
          stt_ms: sttMs,
          embedding_ms: embeddingMs,
          retrieval_ms: retrievalMs,
          generation_ms: generationMs,
          total_ms: totalMs,
        },
        error: errorHint,
      };
    } catch (error) {
      console.error("[rag-answer]", error);
      return {
        answer: "",
        sources: [] as string[],
        latency: null,
        error: friendlyError((error as Error).message),
      };
    }
  });
