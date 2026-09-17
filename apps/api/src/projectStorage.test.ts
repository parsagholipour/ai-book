import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { loadConfig } from "@book-maker/core";
import { deleteProjectStorage } from "./projectStorage.js";
import { seedObject, testObjectStore } from "./testing/objectStorage.js";

describe("project object cleanup", () => {
  it("deletes every project category without touching sibling projects or library characters", async () => {
    for (const category of ["books", "images", "voice", "audio"]) {
      seedObject(`${category}/project-1/nested/artifact`, "delete");
      seedObject(`${category}/project-10/artifact`, "keep");
    }
    seedObject("images/characters/user-a/portrait.webp", "keep");
    const warn = vi.fn();
    const result = await deleteProjectStorage(loadConfig(), "project-1", { log: { warn } } as unknown as FastifyRequest);
    expect(result).toEqual({ book: true, images: true, voice: true, audio: true });
    expect([...testObjectStore.objects.keys()].sort()).toEqual([
      "audio/project-10/artifact", "books/project-10/artifact", "images/characters/user-a/portrait.webp",
      "images/project-10/artifact", "voice/project-10/artifact"
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports failed storage cleanup while attempting the remaining categories", async () => {
    const deletion = vi.spyOn(testObjectStore, "deletePrefix").mockRejectedValueOnce(new Error("S3 unavailable"));
    const warn = vi.fn();
    try {
      const result = await deleteProjectStorage(loadConfig(), "project-1", { log: { warn } } as unknown as FastifyRequest);
      expect(result).toEqual({ book: false, images: true, voice: true, audio: true });
      expect(deletion).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      deletion.mockRestore();
    }
  });
});
