#!/usr/bin/env node
/**
 * awaykit adapter — Aider (notify-only).
 *
 * Aider has no pre-execution approval hook, so awaykit can't gate its commands —
 * the best integration is a heads-up. Aider runs `--notifications-command` when a
 * response is ready; point it here to buzz your phone.
 *
 * Install:
 *   aider --notifications \
 *         --notifications-command "node /path/to/awaykit/daemon/src/adapters/aider-notify.js"
 *
 * For approve/deny with Aider, gate risky commands yourself with `awaykit-ask`.
 */
import { notify } from "../agent-core.js";

notify({ icon: "🔔", text: "Aider is ready for you" })
  .catch(() => {})
  .finally(() => process.exit(0));
