import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AlibabaImageAdapter, AlibabaTextAdapter } from "./alibaba.js";

describe("AlibabaTextAdapter", () => {
  it("keeps provider usage on JSON validation errors", async () => {
    const adapter = new AlibabaTextAdapter({ apiKey: "test-key", textModel: "qwen-plus" });
    (adapter as any).client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: `{ "approved": "yes" }` } }],
            usage: { prompt_tokens: 123, completion_tokens: 45 }
          })
        }
      }
    };

    await expect(
      adapter.generateJson({
        purpose: "plan-book",
        messages: [{ role: "user", content: "Return a report." }],
        schema: z.object({ approved: z.boolean() })
      })
    ).rejects.toMatchObject({
      provider: "alibaba",
      model: "qwen-plus",
      usage: { promptTokens: 123, outputTokens: 45 }
    });
  });
});

describe("AlibabaImageAdapter", () => {
  it("reports Qwen Image 2.0 models can consume up to three references", () => {
    for (const imageModel of ["qwen-image-2.0", "qwen-image-2.0-pro"]) {
      const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel });

      expect(adapter.capabilities()).toEqual({
        supportsReferenceImages: true,
        maxReferenceImages: 3
      });
    }

    const legacyAdapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-plus" });
    expect(legacyAdapter.capabilities()).toEqual({
      supportsReferenceImages: false,
      maxReferenceImages: 0
    });
  });

  it("sends reference images as base64 image parts for Qwen Image 2.0", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "book-maker-qwen-ref-"));
    const referencePath = join(tempDir, "nora.png");
    const secondReferencePath = join(tempDir, "milo.webp");
    await writeFile(referencePath, Buffer.from("fake-png"));
    await writeFile(secondReferencePath, Buffer.from("fake-webp"));
    const calls = mockAlibabaImageFetch();
    const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0" });

    try {
      await adapter.generateImage({
        prompt: "Illustrate Nora and Milo beside the moon bell.",
        referenceImagePaths: [referencePath, secondReferencePath]
      });
    } finally {
      calls.restore();
      await rm(tempDir, { recursive: true, force: true });
    }

    const content = calls.bodies[0]?.input?.messages?.[0]?.content;
    expect(content).toEqual([
      { image: `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}` },
      { image: `data:image/webp;base64,${Buffer.from("fake-webp").toString("base64")}` },
      { text: "Illustrate Nora and Milo beside the moon bell." }
    ]);
  });

  it("clips Qwen reference images to the supported limit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "book-maker-qwen-ref-limit-"));
    const referencePaths = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const path = join(tempDir, `reference-${index + 1}.png`);
        await writeFile(path, Buffer.from(`fake-png-${index + 1}`));
        return path;
      })
    );
    const calls = mockAlibabaImageFetch();
    const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-2.0-pro" });

    try {
      await adapter.generateImage({
        prompt: "Illustrate the selected characters.",
        referenceImagePaths: referencePaths
      });
    } finally {
      calls.restore();
      await rm(tempDir, { recursive: true, force: true });
    }

    const content = calls.bodies[0]?.input?.messages?.[0]?.content;
    expect(content).toHaveLength(4);
    expect(content.filter((part: Record<string, unknown>) => "image" in part)).toHaveLength(3);
    expect(content[3]).toEqual({ text: "Illustrate the selected characters." });
    expect(JSON.stringify(content)).not.toContain(Buffer.from("fake-png-4").toString("base64"));
  });

  it("rejects reference images for unsupported Qwen image models", async () => {
    const adapter = new AlibabaImageAdapter({ apiKey: "test-key", imageModel: "qwen-image-plus" });

    await expect(
      adapter.generateImage({
        prompt: "Illustrate Nora.",
        referenceImagePaths: ["/tmp/nora.png"]
      })
    ).rejects.toThrow(/cannot consume character reference images/i);
  });
});

function mockAlibabaImageFetch() {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    if (typeof init?.body === "string") {
      bodies.push(JSON.parse(init.body));
    }
    return new Response(
      JSON.stringify({
        output: {
          choices: [
            {
              message: {
                content: [{ image: "https://example.com/generated.png" }]
              }
            }
          ]
        }
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  return {
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch;
    }
  };
}
