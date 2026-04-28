import React from "react";
import { render } from "ink";

import type { OahConnection } from "./oah-api.js";
import { OahTui } from "./tui.js";

export async function launchTui(connection: OahConnection): Promise<void> {
  const instance = render(<OahTui connection={connection} />, {
    alternateScreen: true,
    maxFps: 20
  });
  await instance.waitUntilExit();
}
