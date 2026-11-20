/** Per chat turn limits of the M3 agent (enforced by the agent loop). */
export const AGENT_LIMITS = {
  /** Tool calls the model may make in one chat turn. */
  maxToolCalls: 6,
  /** Of those, write tools (create_post, update_post) executed in one turn. */
  maxWrites: 3,
  /** Model round trips in one turn (tool calls + the final answer). */
  maxModelTurns: 8,
  /** Overall time budget for one turn, in milliseconds. */
  turnDeadlineMs: 45_000,
  /** Upper bound for the model's output per round trip. */
  maxOutputTokens: 2_000,
} as const;
