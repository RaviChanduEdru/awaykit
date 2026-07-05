#!/usr/bin/env node
/**
 * awaykit-ask — a generic, agent-agnostic approval gate.
 *
 * Ask your phone to approve/deny ANY command or action — from a shell script, a
 * CI step, or any coding agent that can be configured to run a command for
 * approval. It blocks until you answer on your phone (card shows the summary +
 * detail), so it's the universal fallback for agents without a rich hook system.
 *
 *   awaykit-ask "Deploy to prod?"        &&  ./deploy.sh
 *   awaykit-ask "Run migration" "$SQL"   ||  echo "you said no"
 *   echo "publish v2?" | awaykit-ask                 # summary from stdin
 *
 * Exit codes:  0 approved · 1 denied · 2 no decision (no phone connected /
 * daemon down / aborted). A denial's typed note, if any, prints to stderr — so
 * agents that surface a rejected command's output still see your steering.
 */

import { requestPermission, readStdin } from "../agent-core.js";

async function main() {
  const args = process.argv.slice(2);
  let summary = args[0];
  const detail = args.slice(1).join(" ");
  if (!summary) summary = (await readStdin()).trim(); // allow: echo "..." | awaykit-ask
  if (!summary) {
    process.stderr.write("usage: awaykit-ask <summary> [detail…]   (or pipe the summary on stdin)\n");
    process.exit(2);
  }

  try {
    const r = await requestPermission({ tool: "command", summary, detail, cwd: process.cwd() });
    if (r && r.choice === "approve") process.exit(0);
    if (r && r.choice === "deny") {
      if (r.note) process.stderr.write(`awaykit: denied — ${r.note}\n`);
      else process.stderr.write("awaykit: denied\n");
      process.exit(1);
    }
    // choice null/aborted → no phone was there to decide. Fail closed (exit 2) so
    // a `&&` chain does NOT run the guarded command when nobody approved it.
    process.stderr.write("awaykit: no decision — no phone connected (nothing approved)\n");
    process.exit(2);
  } catch {
    process.stderr.write("awaykit: daemon unreachable — start it with `npm start`\n");
    process.exit(2);
  }
}

main();
