import { describe, expect, it } from "vitest";

import { buildSessionEventStreamPath } from "../apps/web/src/app/use-session-event-stream";

describe("web session event stream", () => {
  it("starts existing sessions at the latest event when no cursor is set", () => {
    expect(buildSessionEventStreamPath("ses_123", undefined)).toEqual({
      cursor: "$latest",
      path: "/api/v1/sessions/ses_123/events?cursor=%24latest"
    });
  });

  it("keeps explicit resume cursors", () => {
    expect(buildSessionEventStreamPath("ses_123", "42")).toEqual({
      cursor: "42",
      path: "/api/v1/sessions/ses_123/events?cursor=42"
    });
  });
});
