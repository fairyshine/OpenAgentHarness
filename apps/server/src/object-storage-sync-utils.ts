export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(items.length, concurrency));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }

        await worker(items[index]!);
      }
    })
  );
}

export function hasDirectorySyncMutations(input: {
  uploadedFileCount: number;
  deletedRemoteCount: number;
  createdEmptyDirectoryCount: number;
}): boolean {
  return input.uploadedFileCount > 0 || input.deletedRemoteCount > 0 || input.createdEmptyDirectoryCount > 0;
}
