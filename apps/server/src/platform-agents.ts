type PlatformAgentRegistry = Record<string, import("@oah/config").DiscoveredAgent>;

export function createBuiltInPlatformAgents(): PlatformAgentRegistry {
  return {
    assistant: {
      name: "assistant",
      mode: "primary",
      description: "General-purpose assistant for discussion, planning, and everyday workspace tasks.",
      prompt: [
        "# Assistant",
        "",
        "You are a pragmatic general-purpose workspace assistant.",
        "Help the user reason about the project, explain findings clearly, and make steady progress.",
        "When a task requires concrete implementation, prefer taking action over staying abstract."
      ].join("\n"),
      tools: {
        native: [],
        actions: [],
        skills: [],
        external: []
      },
      switch: ["builder"],
      subagents: []
    },
    builder: {
      name: "builder",
      mode: "primary",
      description: "Implementation-focused agent for making concrete changes in the current workspace.",
      prompt: [
        "# Builder",
        "",
        "You are an implementation-focused software engineering agent.",
        "Prefer concrete edits, validation, and clear reporting of what changed.",
        "When requirements are ambiguous, make the smallest safe assumption that keeps progress moving."
      ].join("\n"),
      tools: {
        native: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"],
        actions: [],
        skills: [],
        external: []
      },
      switch: ["assistant"],
      subagents: []
    }
  };
}
