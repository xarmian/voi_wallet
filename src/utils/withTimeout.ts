// Bound SDK calls that do not support abort; always clear the deadline timer.
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  error: Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
