import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";

import { ingestCorpus, ragAnswer, speechToText } from "@/lib/rag.functions";
import { blobToBase64, startRecording, type Recorder } from "@/lib/recorder";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Voice RAG MVP — Ask questions by voice" },
      {
        name: "description",
        content:
          "A minimal voice-enabled retrieval augmented generation demo: load a corpus, speak a question, get a grounded answer with latency stats.",
      },
      { property: "og:title", content: "Voice RAG MVP — Ask questions by voice" },
      {
        property: "og:description",
        content:
          "Load a real MS MARCO corpus, ask a question with your voice, and get an answer grounded in retrieved passages.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const ingest = useServerFn(ingestCorpus);
  const stt = useServerFn(speechToText);
  const answerFn = useServerFn(ragAnswer);

  const [loadStatus, setLoadStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [latency, setLatency] = useState<{
    total_ms: number;
    stt_ms: number;
    embedding_ms: number;
    retrieval_ms: number;
    generation_ms: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleLoad() {
    setLoading(true);
    setLoadStatus("Loading dataset…");
    const stages = [
      "Fetching Hugging Face rows…",
      "Creating embeddings…",
      "Storing vectors…",
    ];
    let stage = 0;
    const timer = setInterval(() => {
      if (stage < stages.length) setLoadStatus(stages[stage++]!);
    }, 2500);
    try {
      const result = await ingest();
      if (result.already_loaded) {
        setLoadStatus(`Already loaded ${result.chunks_created} chunks`);
      } else if (result.chunks_created > 0) {
        setLoadStatus(
          `Loaded ${result.chunks_created} chunks` +
            (result.errors.length ? ` (${result.errors.length} errors)` : ""),
        );
      } else {
        setLoadStatus(
          `Failed to load dataset: ${result.errors[0] ?? "no passages found"}`,
        );
      }
    } catch (e) {
      setLoadStatus(`Failed to load dataset: ${(e as Error).message}`);
    } finally {
      clearInterval(timer);
      setLoading(false);
    }
  }

  async function handleMic() {
    setError(null);
    if (recorder) {
      const active = recorder;
      setRecorder(null);
      setBusy("Transcribing…");
      try {
        const blob = await active.stop();
        const audioBase64 = await blobToBase64(blob);
        const sttStart = Date.now();
        const sttResult = await stt({ data: { audioBase64 } });
        const sttMs = Date.now() - sttStart;
        if (sttResult.error) throw new Error(sttResult.error);
        setTranscript(sttResult.transcript);
        if (!sttResult.transcript.trim()) throw new Error("No speech detected.");

        setBusy("Thinking…");
        const result = await answerFn({
          data: { query: sttResult.transcript, sttMs },
        });
        if (result.error) throw new Error(result.error);
        setAnswer(result.answer);
        setSources(result.sources);
        setLatency(result.latency);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
      return;
    }

    try {
      setTranscript("");
      setAnswer("");
      setSources([]);
      setLatency(null);
      setRecorder(await startRecording());
    } catch {
      setError("Microphone access is needed to record.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-10 px-6 py-14">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Voice RAG MVP</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Load the corpus once, then ask a question out loud.
        </p>
      </header>

      <section className="rounded-lg border border-border p-5">
        <div className="flex items-center gap-3">
          <button
            onClick={handleLoad}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            Load Data
          </button>
          <span className="text-sm text-muted-foreground">{loadStatus}</span>
        </div>
      </section>

      <section className="flex flex-col items-center gap-4 rounded-lg border border-border p-8">
        <button
          onClick={handleMic}
          disabled={busy !== null}
          className={`inline-flex size-20 items-center justify-center rounded-full transition-colors disabled:opacity-60 ${
            recorder
              ? "bg-destructive text-destructive-foreground"
              : "bg-primary text-primary-foreground hover:bg-primary/90"
          }`}
          aria-label={recorder ? "Stop recording" : "Start recording"}
        >
          {busy ? (
            <Loader2 className="size-7 animate-spin" />
          ) : recorder ? (
            <Square className="size-7" />
          ) : (
            <Mic className="size-8" />
          )}
        </button>
        <p className="text-sm text-muted-foreground">
          {busy ?? (recorder ? "Recording… tap to stop" : "Tap to ask a question")}
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {transcript && (
          <div className="w-full rounded-md bg-muted p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Transcript
            </p>
            <p className="mt-1 text-sm">{transcript}</p>
          </div>
        )}

        {answer && (
          <div className="w-full rounded-md border border-border p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Answer
            </p>
            <p className="mt-1 text-sm leading-relaxed">{answer}</p>
          </div>
        )}

        {sources.length > 0 && (
          <div className="w-full rounded-md border border-border p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Sources
            </p>
            <ul className="mt-2 space-y-2">
              {sources.map((s, i) => (
                <li key={i} className="text-xs leading-relaxed text-muted-foreground">
                  • {s}
                </li>
              ))}
            </ul>
          </div>
        )}

        {latency && (
          <div className="w-full rounded-md bg-muted p-4 text-xs text-muted-foreground">
            <p className="font-medium uppercase tracking-wide">Latency</p>
            <p className="mt-1">Total: {Math.round(latency.total_ms)} ms</p>
            <p>
              STT {Math.round(latency.stt_ms)} ms · embed {Math.round(latency.embedding_ms)} ms ·
              retrieval {Math.round(latency.retrieval_ms)} ms · generation{" "}
              {Math.round(latency.generation_ms)} ms
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
