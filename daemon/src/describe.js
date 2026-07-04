/**
 * Turn a Claude Code tool call into a human summary + detail for the phone card.
 *
 * The detail is what lets you actually *judge* an action from your phone: the
 * exact command for Bash, the file contents for Write, a -/+ diff for Edit. Kept
 * in its own module so it's unit-testable (see test/e2e.mjs).
 */

const MAX = 1800;
const clip = (s) => {
  s = String(s ?? "");
  return s.length > MAX ? s.slice(0, MAX) + `\n… (+${s.length - MAX} more chars)` : s;
};
const firstLine = (s, n = 80) => String(s ?? "").split("\n")[0].slice(0, n);
const diff = (oldStr, newStr) =>
  `- ${String(oldStr ?? "").replace(/\n/g, "\n- ")}\n+ ${String(newStr ?? "").replace(/\n/g, "\n+ ")}`;

export function describe(toolName, input) {
  input = input || {};
  switch (toolName) {
    case "Bash":
      return { summary: input.command ? `Run: ${firstLine(input.command)}` : "Run a shell command", detail: clip(input.command) };

    case "Write": {
      const lines = String(input.content ?? "").split("\n").length;
      return { summary: `Write ${input.file_path || "a file"} (${lines} line${lines === 1 ? "" : "s"})`, detail: clip(input.content) };
    }

    case "Edit":
      return { summary: `Edit ${input.file_path || "a file"}`, detail: clip(diff(input.old_string, input.new_string)) };

    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const body = edits.map((e, i) => `@@ change ${i + 1}\n${diff(e.old_string, e.new_string)}`).join("\n\n");
      return { summary: `Edit ${input.file_path || "a file"} (${edits.length} change${edits.length === 1 ? "" : "s"})`, detail: clip(body) };
    }

    case "NotebookEdit":
      return { summary: `Edit notebook ${input.notebook_path || ""}`, detail: clip(input.new_source) };

    case "Read":
      return { summary: `Read ${input.file_path || "a file"}`, detail: input.file_path || "" };

    case "WebFetch":
      return { summary: `Fetch ${input.url || "a URL"}`, detail: clip([input.url, input.prompt].filter(Boolean).join("\n\n")) };

    default: {
      let detail = "";
      try { detail = JSON.stringify(input, null, 2); } catch { /* non-serialisable */ }
      return { summary: `${toolName}`, detail: clip(detail) };
    }
  }
}
