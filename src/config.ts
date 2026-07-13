import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "retrievalLimit",
    "numeric",
    {
      int: true,
      min: 1,
      displayName: "Retrieval Limit",
      subtitle: "When retrieval is triggered, this is the maximum number of chunks to return.",
      slider: { min: 1, max: 10, step: 1 },
    },
    3,
  )
  .field(
    "retrievalAffinityThreshold",
    "numeric",
    {
      min: 0.0,
      max: 1.0,
      displayName: "Retrieval Affinity Threshold",
      subtitle: "The minimum similarity score for a chunk to be considered relevant.",
      slider: { min: 0.0, max: 1.0, step: 0.01 },
    },
    0.5,
  )
  .field(
    "enableOcrFallback",
    "boolean",
    {
      displayName: "Enable OCR Fallback",
      subtitle: "If a PDF has little to no extractable text (e.g. a scanned/flat document), run OCR to recover it. Slower, but recovers text from image-based PDFs.",
    },
    true,
  )
  .field(
    "embeddingModel",
    "string",
    {
      displayName: "Embedding Model",
      subtitle: "Model identifier used for document retrieval embeddings. Must already be downloaded/available in LM Studio — this plugin does not trigger a download.",
      placeholder: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    },
    "nomic-ai/nomic-embed-text-v1.5-GGUF",
  )
  .build();