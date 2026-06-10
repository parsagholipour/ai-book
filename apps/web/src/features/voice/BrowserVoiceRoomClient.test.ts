import { describe, expect, it } from "vitest";
import {
  buildOpenAIVoiceRoomResponseCreateEvent,
  shouldCancelOpenAIUnscheduledResponseEvent,
  VoiceRoomConductor
} from "./BrowserVoiceRoomClient.js";

const characters = [
  { id: "lina", name: "Lina" },
  { id: "orlo", name: "Captain Orlo" },
  { id: "mira", name: "Mira Vale" }
];

describe("VoiceRoomConductor", () => {
  it("routes user turns by character name mention", () => {
    const conductor = new VoiceRoomConductor(characters);

    const next = conductor.appendUserTurn("Captain Orlo, what did you see by the moon gate?");

    expect(next?.id).toBe("orlo");
  });

  it("falls back to round-robin and avoids the same speaker twice", () => {
    const conductor = new VoiceRoomConductor(characters);

    const first = conductor.appendUserTurn("What should we do next?");
    const second = conductor.appendCharacterTurn(first!.id, "I think we should keep moving.");

    expect(first?.id).toBe("lina");
    expect(second?.id).toBe("orlo");
  });

  it("caps autonomous turns after the user starts a topic", () => {
    const conductor = new VoiceRoomConductor(characters, { autoTurnsAfterUser: 2 });

    const first = conductor.appendUserTurn("Talk through the plan.");
    const second = conductor.appendCharacterTurn(first!.id, "I can scout ahead.");
    const third = conductor.appendCharacterTurn(second!.id, "I will watch the compass.");

    expect(first?.id).toBe("lina");
    expect(second?.id).toBe("orlo");
    expect(third).toBeNull();
  });

  it("marks the final autonomous character turn as a closer", () => {
    const conductor = new VoiceRoomConductor(characters, { autoTurnsAfterUser: 2 });

    const first = conductor.appendUserTurn("Talk through the plan.");
    expect(conductor.buildPrompt(first!)).not.toContain("final autonomous character turn");

    const second = conductor.appendCharacterTurn(first!.id, "I can scout ahead.");
    const finalPrompt = conductor.buildPrompt(second!);

    expect(finalPrompt).toContain("final autonomous character turn");
    expect(finalPrompt).toContain("Do not end with a question");
  });

  it("continues the default room beyond the first two character replies", () => {
    const conductor = new VoiceRoomConductor(characters);

    const first = conductor.appendUserTurn("Talk through the plan.");
    const second = conductor.appendCharacterTurn(first!.id, "I can scout ahead.");
    const third = conductor.appendCharacterTurn(second!.id, "I will watch the compass.");

    expect(first?.id).toBe("lina");
    expect(second?.id).toBe("orlo");
    expect(third?.id).toBe("mira");
  });

  it("can advance a character turn when provider audio has no final transcript", () => {
    const conductor = new VoiceRoomConductor(characters, { autoTurnsAfterUser: 2 });

    const first = conductor.appendUserTurn("Talk through the plan.");
    const second = conductor.appendCharacterTurn(first!.id, "", { advanceWithoutTranscript: true });

    expect(first?.id).toBe("lina");
    expect(second?.id).toBe("orlo");
    expect(conductor.recentTurnCount()).toBe(1);
  });

  it("clears in-memory room turns", () => {
    const conductor = new VoiceRoomConductor(characters);
    conductor.appendUserTurn("Lina, start us off.");

    expect(conductor.recentTurnCount()).toBe(1);
    conductor.clear();

    expect(conductor.recentTurnCount()).toBe(0);
    expect(conductor.buildPrompt(characters[0]!)).toContain("just started");
  });

  it("resets routing when the user interrupts a character turn", () => {
    const conductor = new VoiceRoomConductor(characters);
    conductor.appendUserTurn("Start the debate.");

    const next = conductor.appendUserTurn("Mira, wait, answer this first.");

    expect(next?.id).toBe("mira");
  });
});

describe("OpenAI voice room events", () => {
  it("requests audio output with the current Realtime response field", () => {
    const event = buildOpenAIVoiceRoomResponseCreateEvent("Lina");

    expect(event).toMatchObject({
      type: "response.create",
      response: {
        output_modalities: ["audio"]
      }
    });
    expect(event.response).not.toHaveProperty("modalities");
  });

  it("cancels participant response events unless the conductor selected that speaker", () => {
    expect(shouldCancelOpenAIUnscheduledResponseEvent("lina", "orlo", "response.created")).toBe(true);
    expect(shouldCancelOpenAIUnscheduledResponseEvent("lina", "orlo", "response.audio.delta")).toBe(true);
    expect(shouldCancelOpenAIUnscheduledResponseEvent(null, "orlo", "response.created")).toBe(true);
    expect(shouldCancelOpenAIUnscheduledResponseEvent("lina", "lina", "response.created")).toBe(false);
    expect(shouldCancelOpenAIUnscheduledResponseEvent("lina", "orlo", "conversation.item.created")).toBe(false);
    expect(shouldCancelOpenAIUnscheduledResponseEvent("lina", "orlo", "response.done")).toBe(false);
  });
});
