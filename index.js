import "dotenv/config";
import crypto from "crypto";
import express from "express";
import { Octokit } from "octokit";

const app = express();
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

function isValidSignature(req) {
  const sig = req.get("x-hub-signature-256") || "";
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest("hex");
  return (
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  );
}

const MODELS = [
  process.env.AI_MODEL,
  "openrouter/free",
  "cohere/north-mini-code:free",
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel(model, diff) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a senior code reviewer. Review the given git diff for bugs, " +
            "security issues, and bad practices. Use 🔴 for critical, 🟡 for warning, " +
            "🟢 for suggestion. Be concise and explain why each issue matters.",
        },
        { role: "user", content: diff.slice(0, 15000) },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(JSON.stringify(data));
    err.status = res.status;
    throw err;
  }
  return data.choices[0].message.content;
}

async function reviewDiff(diff) {
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Trying ${model} (attempt ${attempt})`);
        return await callModel(model, diff);
      } catch (err) {
        console.error(`Failed: ${model} -> status ${err.status}`);
        if (err.status === 429) await sleep(3000 * attempt);
        else break; // 429 nahi hai to retry ka faayda nahi, agla model try karo
      }
    }
  }
  throw new Error("All models failed");
}

app.get("/", (req, res) => res.send("Bot is running!"));

app.post("/webhook", async (req, res) => {
  if (!isValidSignature(req)) return res.status(401).send("Invalid signature");
  res.sendStatus(200);

  const { action, pull_request, repository } = req.body;
  if (!["opened", "synchronize"].includes(action)) return;

  const owner = repository.owner.login;
  const repo = repository.name;
  const pull_number = pull_request.number;
  console.log(`PR #${pull_number} ${action} in ${repository.full_name}`);

  try {
    const { data: diff } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number,
      mediaType: { format: "diff" },
    });

    const review = await reviewDiff(String(diff));
    console.log("Review ready, posting comment...");

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pull_number,
      body: "** AI Review**\n\n" + review,
    });
    console.log("Comment posted!");
  } catch (err) {
    console.error("Review failed:", err.message);
  }
});

app.listen(3000, () => console.log("Running on http://localhost:3000"));