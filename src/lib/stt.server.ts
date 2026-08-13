import { withRetry } from "./rag.server";

/** Calls Sarvam AI speech-to-text with base64 audio and returns the transcript. */
export async function transcribe(audioBase64: string): Promise<string> {
  const key = process.env["SARVAM_API_KEY"];
  if (!key) throw new Error("Missing SARVAM_API_KEY");

  const binary = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
  if (binary.byteLength < 2048) throw new Error("Recording was empty — please try again.");

  return withRetry(async () => {
    const form = new FormData();
    form.append("file", new Blob([binary], { type: "audio/wav" }), "recording.wav");
    form.append("model", "saarika:v2.5");

    const res = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": key },
      body: form,
    });
    if (!res.ok) throw new Error(`Sarvam STT ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { transcript?: string };
    return json.transcript ?? "";
  }, "speech-to-text");
}
