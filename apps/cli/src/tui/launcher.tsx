import React from "react";
import { render } from "ink";

import type { OahConnection } from "../api/oah-api.js";
import { OahTui } from "./OahTui.js";

export async function launchTui(connection: OahConnection): Promise<void> {
  const instance = render(<OahTui connection={connection} />, {
    alternateScreen: true,
    maxFps: 20
  });
  await instance.waitUntilExit();
}
