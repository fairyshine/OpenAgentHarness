export function installSignalHandlers(options: { close: () => Promise<void>; beginDrain?: (() => Promise<void>) | undefined }): void {
  let closing: Promise<void> | undefined;

  const shutdown = () => {
    if (!closing) {
      closing = (async () => {
        try {
          await options.beginDrain?.();
          await options.close();
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
        }
      })();
    }

    return closing;
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit());
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit());
  });
}
