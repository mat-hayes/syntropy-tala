import express from "express";
import Redis from "ioredis";

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const FILTER_API_KEY = process.env.FILTER_API_KEY;
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 15000);
const MEMORY_API_URL = process.env.MEMORY_API_URL;

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  : new Redis({
      host: process.env.REDISHOST,
      port: Number(process.env.REDISPORT || 6379),
      password: process.env.REDISPASSWORD || undefined,
      maxRetriesPerRequest: null,
    });

function getRemoteJid(payload) {
  return (
    payload?.data?.key?.remoteJid ||
    payload?.key?.remoteJid ||
    payload?.data?.remoteJid ||
    payload?.remoteJid ||
    payload?.jid ||
    null
  );
}

function keyForJid(jid) {
  return `ignore:${jid}`;
}

function authMiddleware(req, res, next) {
  const apiKey = req.headers["x-filter-key"];
  if (!FILTER_API_KEY || apiKey !== FILTER_API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

async function getIgnoreRule(jid) {
  const raw = await redis.get(keyForJid(jid));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setIgnoreRule({ jid, ignoreUntil = null, reason = null }) {
  const nowIso = new Date().toISOString();
  const existing = await getIgnoreRule(jid);

  const rule = {
    jid,
    ignoreUntil,
    reason,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  const key = keyForJid(jid);

  if (ignoreUntil) {
    const ttlMs = new Date(ignoreUntil).getTime() - Date.now();
    if (ttlMs > 0) {
      await redis.set(key, JSON.stringify(rule), "PX", ttlMs);
      return rule;
    }
  }

  await redis.set(key, JSON.stringify(rule));
  return rule;
}

async function setIgnoreRuleByMinutes({ jid, minutes, reason = null }) {
  const ignoreUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  return setIgnoreRule({ jid, ignoreUntil, reason });
}

async function removeIgnoreRule(jid) {
  const result = await redis.del(keyForJid(jid));
  return result > 0;
}

async function isIgnored(jid) {
  const rule = await getIgnoreRule(jid);
  if (!rule) return { ignored: false, rule: null };

  if (!rule.ignoreUntil) return { ignored: true, rule };

  const until = new Date(rule.ignoreUntil).getTime();
  if (Number.isNaN(until)) return { ignored: true, rule };

  if (until > Date.now()) return { ignored: true, rule };

  await removeIgnoreRule(jid);
  return { ignored: false, rule: null };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "evolution-webhook-filter"
  });
});

app.get("/ignored/:jid", authMiddleware, async (req, res) => {
  try {
    const jid = req.params.jid;
    const rule = await getIgnoreRule(jid);

    res.json({
      ok: true,
      exists: !!rule,
      rule,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "read_failed",
    });
  }
});

app.post("/ignore", authMiddleware, async (req, res) => {
  try {
    const { jid, ignoreUntil = null, minutes = null, reason = null } = req.body || {};

    if (!jid || typeof jid !== "string") {
      return res.status(400).json({
        ok: false,
        error: "jid is required",
      });
    }

    let rule;

    if (minutes !== null && minutes !== undefined) {
      const parsedMinutes = Number(minutes);
      if (!Number.isFinite(parsedMinutes) || parsedMinutes <= 0) {
        return res.status(400).json({
          ok: false,
          error: "minutes must be a positive number",
        });
      }

      rule = await setIgnoreRuleByMinutes({
        jid,
        minutes: parsedMinutes,
        reason,
      });
    } else {
      rule = await setIgnoreRule({
        jid,
        ignoreUntil,
        reason,
      });
    }

    res.json({
      ok: true,
      rule,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "ignore_failed",
    });
  }
});

app.post("/unignore", authMiddleware, async (req, res) => {
  try {
    const { jid } = req.body || {};

    if (!jid || typeof jid !== "string") {
      return res.status(400).json({
        ok: false,
        error: "jid is required",
      });
    }

    const removed = await removeIgnoreRule(jid);

    res.json({
      ok: true,
      removed,
      jid,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "unignore_failed",
    });
  }
});

app.post("/webhook/evolution", async (req, res) => {
  try {
    const payload = req.body || {};
    const jid = getRemoteJid(payload);

    if (!jid) {
      return res.status(200).json({
        ok: true,
        forwarded: false,
        ignored: false,
        reason: "jid_not_found",
      });
    }
  try {
    await persistMessageToMemory(payload);
  } catch (error) {
    console.error("persistMessageToMemory failed:", error?.message || error);
  }
    const ignoreStatus = await isIgnored(jid);

    if (ignoreStatus.ignored) {
      return res.status(200).json({
        ok: true,
        forwarded: false,
        ignored: true,
        jid,
        rule: ignoreStatus.rule,
      });
    }

    if (!N8N_WEBHOOK_URL) {
      return res.status(500).json({
        ok: false,
        error: "N8N_WEBHOOK_URL is not configured",
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

    let forwardResponse;
    try {
      forwardResponse = await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await forwardResponse.text();

    return res.status(200).json({
      ok: true,
      forwarded: true,
      ignored: false,
      jid,
      n8nStatus: forwardResponse.status,
      n8nBodyPreview: text.slice(0, 300),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "unexpected_error",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});

function getMessageText(payload) {
  return (
    payload?.data?.message?.conversation ||
    payload?.data?.message?.extendedTextMessage?.text ||
    payload?.message?.conversation ||
    payload?.message?.extendedTextMessage?.text ||
    ""
  );
}

function isFromMe(payload) {
  return !!(
    payload?.data?.key?.fromMe ||
    payload?.key?.fromMe
  );
}

function getMessageType(payload) {
  const msg =
    payload?.data?.message ||
    payload?.message ||
    {};

  if (msg?.audioMessage) return "audio";
  if (msg?.imageMessage) return "image";
  if (msg?.videoMessage) return "video";
  if (msg?.documentMessage) return "document";
  return "text";
}

async function persistMessageToMemory(payload) {
  if (!MEMORY_API_URL) return;

  const jid = getRemoteJid(payload);
  if (!jid) return;

  const fromMe = isFromMe(payload);
  const content = getMessageText(payload);
  const messageType = getMessageType(payload);

  const role = fromMe ? "owner" : "user";
  const sent_by_me = fromMe;

  await fetch(`${MEMORY_API_URL}/debug/insert-message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: jid,
      role,
      content: content || `__${messageType.toUpperCase()}__`,
      sender_id: jid,
      sent_by_me,
      message_type: messageType,
    }),
  });
}
