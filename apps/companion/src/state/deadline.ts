export class OperationStalled extends Error {
  readonly statusCode = 503;
  readonly code = "operation_stalled";
  constructor(readonly operation: string, ms: number) { super(`${operation} stalled after ${ms} ms; retry retained input.`); }
}

/** A deadline does not cancel arbitrary promises. Mutating callers MUST check immediately before publishing
 * staged state, and pass the check into nested transactions. Late work can finish but cannot commit. */
export async function withinDeadline<T>(operation: string, ms: number, work: (check: () => void) => Promise<T>): Promise<T> {
  const failure = new OperationStalled(operation, ms);
  let expired = false, timer: ReturnType<typeof setTimeout>;
  // Cancellation is latched by the timer task. Do not separately compare the clock: a millisecond boundary between
  // history installation and engine publication (one uninterrupted microtask turn) must not split their commit.
  const check = () => { if (expired) throw failure; };
  try {
    return await Promise.race([work(check), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(failure); }, ms);
    })]);
  } finally { clearTimeout(timer!); }
}
