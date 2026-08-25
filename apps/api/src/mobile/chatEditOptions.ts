import { type BookEditIntent } from "../bookEditIntent.js";
import { type ProjectForChat } from "./projectChat.js";

/** The common input carried by every confirmed mobile chat edit queue path. */
export type QueuedChatEdit = {
  userId: string;
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  /** Stable claim shared by typed confirmation and the proposal Apply button. */
  executionCommandId?: string | undefined;
  /** The proposal card's price; a recomputed charge may not exceed it. */
  quotedCredits?: number | undefined;
  /** Mentioned character sheets carried through the edit's model prompts. */
  characterContext?: string | undefined;
};

/** The common input carried by every mobile chat edit proposal path. */
export type ProposedChatEdit = {
  project: ProjectForChat;
  userMessageId: string;
  message: string;
  intent: BookEditIntent;
  /** Mentioned character sheets stored with the pending proposal. */
  characterContext?: string | undefined;
};
