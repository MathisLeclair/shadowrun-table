// Throw from an action handler to send a readable error back to the client (no stack trace logged).
export class ActionError extends Error {}
