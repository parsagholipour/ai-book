import { bookEditScopeFromMessage, messageWithFollowUp, messageWithScope, type BookEditScope } from "../bookEditIntent.js";
import {
  isPendingEditCancellationMessage,
  isPendingEditConfirmationMessage,
  type PendingEditState
} from "./bookEditIntents.js";

/**
 * How a new chat message resolves the project's pending edit — the pure half
 * of the one-clarifying-question rule (see the root CLAUDE.md gotcha). Given
 * the stored pending state and the message, this derives everything the route
 * needs: whether the pending edit is resumed, confirmed, or exhausted into a
 * forced decision, and what message the router should actually see.
 */
export type PendingEditTurnResolution = {
  /** Scope named by the new message itself. */
  currentScope: BookEditScope;
  /**
   * Busy-queued edits and priced proposals carry their full target already;
   * a bare confirmation ("apply it") is enough to resume them. Scope
   * clarifications still need an actual scope answer.
   */
  pendingCarriesFullRequest: boolean;
  resolvesPendingScope: boolean;
  /** The resumed edit, stamped onto the USER row so a later turn cannot re-apply it. */
  resolvedPendingEdit: { request: string; scope: BookEditScope; scopeMessage: string } | null;
  /**
   * One clarifying question per request. A scope clarification whose scope is
   * still "none" can never be resolved by the gate above — no reply satisfies
   * it — so an answer that adds no scope would be met with the same question
   * forever. Route it as a forced decision instead, carrying the original
   * request so the router sees more than the fragment.
   */
  clarifyExhausted: boolean;
  /** What the router classifies: the resumed request, the merged follow-up, or the message as sent. */
  resolvedMessage: string;
  /**
   * A pure confirmation of a priced proposal executes it; any other reply
   * (new scope, refined request) goes back through routing and re-pricing.
   */
  confirmedPendingEdit: boolean;
  /**
   * Whether the recovery reply has something to recover — a stranded scope or
   * a priced proposal. A bare scope clarification's recovery message is itself
   * another question, so an insistent follow-up must fall through to the
   * forced decision instead.
   */
  pendingScopeIsRecoverable: boolean;
};

export function resolvePendingEditTurn(
  pendingScope: PendingEditState | null,
  message: string,
  options: { currentScope?: BookEditScope } = {}
): PendingEditTurnResolution {
  const currentScope = options.currentScope ?? bookEditScopeFromMessage(message);
  const pendingResolutionScope = currentScope !== "none" ? currentScope : pendingScope?.scope ?? "none";
  const pendingCarriesFullRequest =
    pendingScope?.clarification === "busy" || pendingScope?.clarification === "confirm";
  const resolvesPendingScope = Boolean(
    pendingScope &&
      (pendingCarriesFullRequest
        ? isPendingEditConfirmationMessage(message) || currentScope !== "none"
        : currentScope !== "none" ||
          (pendingResolutionScope !== "none" && isPendingEditConfirmationMessage(message)))
  );
  const resolvedPendingEdit =
    pendingScope && resolvesPendingScope
      ? {
          request: pendingScope.request,
          scope: pendingResolutionScope,
          scopeMessage: message
        }
      : null;
  const clarifyExhausted = Boolean(
    pendingScope &&
      pendingScope.clarification === "scope" &&
      !resolvesPendingScope &&
      !isPendingEditCancellationMessage(message)
  );
  const resolvedMessage = resolvedPendingEdit
    ? pendingCarriesFullRequest && resolvedPendingEdit.scope === "none"
      ? resolvedPendingEdit.request
      : messageWithScope(resolvedPendingEdit.request, resolvedPendingEdit.scope)
    : clarifyExhausted && pendingScope
      ? messageWithFollowUp(pendingScope.request, message)
      : message;
  const confirmedPendingEdit = Boolean(
    resolvedPendingEdit &&
      pendingScope?.clarification === "confirm" &&
      isPendingEditConfirmationMessage(message)
  );
  const pendingScopeIsRecoverable = Boolean(
    pendingScope && (pendingCarriesFullRequest || pendingScope.scope !== "none")
  );

  return {
    currentScope,
    pendingCarriesFullRequest,
    resolvesPendingScope,
    resolvedPendingEdit,
    clarifyExhausted,
    resolvedMessage,
    confirmedPendingEdit,
    pendingScopeIsRecoverable
  };
}
