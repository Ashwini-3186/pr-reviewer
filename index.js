import "dotenv/config";
import crypto from "crypto";
import express from "express";
import fs from "fs";
import { App } from "octokit";

const app = express();

// Local pe file se, server pe env variable se key padho
const privateKey = process.env.PRIVATE_KEY
  ? process.env.PRIVATE_KEY.replace(/\\n/g, "\n")
  : fs.readFileSync(process.env.PRIVATE_KEY_PATH, "utf8");

const ghApp = new App({
  appId: process.env.APP_ID,
  privateKey,
});

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

// ---------- Diff ko line numbers ke saath annotate karo ----------
function annotateDiff(diff) {
  const valid = {}; // file -> Set of valid line numbers (new file side)
  const out = [];
  let file = null;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("+++ ")) {
        file = line === "+++ /dev/null" ? null : line.slice(4).replace(/^b\//, "");
        if (file) {
          valid[file] = new Set();
          out.push(`\nFILE: ${file}`);
        }
        continue;
      }
      if (line.startsWith("--- ")) continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      inHunk = true;
      continue;
    }
    if (!file || !inHunk) continue;

    if (line.startsWith("+")) {
      valid[file].add(newLine);
      out.push(`${newLine}: ${line.slice(1)}`);
      newLine++;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      continue; // removed line, new file mein nahi hai
    } else {
      valid[file].add(newLine); // context line pe bhi comment ho sakta hai
      out.push(`${newLine}: ${line.slice(1)}`);
      newLine++;
    }
  }
  return { text: out.join("\n"), valid };
}

// ---------- LLM call (retry + fallback) ----------
const MODELS = [
  process.env.AI_MODEL,
  "openrouter/free",
  "cohere/north-mini-code:free",
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = `You are a senior code reviewer. You get a pull request diff where each line is prefixed with its line number in the new file ("LINE: code").
Find real bugs, security issues and bad practices. Do not nitpick style.
Reply with ONLY valid JSON, no markdown fences, in this exact shape:
{"summary": "1-2 sentence overall review", "comments": [{"file": "path/to/file.js", "line": 12, "severity": "critical" | "warning" | "suggestion", "comment": "what is wrong and how to fix it"}]}
Only use file paths and line numbers that appear in the diff. If the code is fine, return an empty comments array.`;

async function callModel(model, diffText) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: diffText.slice(0, 15000) },
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

async function reviewDiff(diffText) {
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Trying ${model} (attempt ${attempt})`);
        return await callModel(model, diffText);
      } catch (err) {
        console.error(`Failed: ${model} -> status ${err.status}`);
        if (err.status === 429) await sleep(3000 * attempt);
        else break;
      }
    }
  }
  throw new Error("All models failed");
}

// Model kabhi JSON ke aage-peeche text ya ``` laga deta hai, isliye safai karo
function parseReview(raw) {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

const ICONS = { critical: "🔴", warning: "🟡", suggestion: "🟢" };

// Har bot comment mein yeh hidden marker hoga, taaki hum apne comments pehchan sakein
const MARKER = "<!-- ai-pr-reviewer -->";

// Kaunse commits review ho chuke (server restart pe reset hota hai, baad mein MongoDB mein le jayenge)
const reviewed = new Set();

async function deleteOldInlineComments({ octokit, owner, repo, pull_number }) {
  const old = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  const mine = old.filter((c) => c.body.includes(MARKER));
  for (const c of mine) {
    await octokit.rest.pulls.deleteReviewComment({ owner, repo, comment_id: c.id });
  }
  return mine.length;
}

async function upsertSummary({ octokit, owner, repo, issue_number, body }) {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const mine = existing.find((c) => c.body.includes(MARKER));
  const fullBody = `${MARKER}\n${body}`;
  if (mine) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body: fullBody });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number, body: fullBody });
  }
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
  const sha = pull_request.head.sha;
  const octokit = await ghApp.getInstallationOctokit(req.body.installation.id);

  const key = `${repository.full_name}#${pull_number}@${sha}`;
  if (reviewed.has(key)) {
    console.log("Already reviewed this commit, skipping");
    return;
  }
  reviewed.add(key);

  console.log(`PR #${pull_number} ${action} (${sha.slice(0, 7)}) in ${repository.full_name}`);

  try {
    const { data: diff } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number,
      mediaType: { format: "diff" },
    });

    const { text, valid } = annotateDiff(String(diff));
    const raw = await reviewDiff(text);
    const review = parseReview(raw);

    // Review mil gaya, ab purane inline comments hata do
    const removed = await deleteOldInlineComments({ octokit, owner, repo, pull_number });
    if (removed) console.log(`Removed ${removed} old inline comments`);

    // JSON parse nahi hua to sirf summary comment (update hota hai, naya nahi banta)
    if (!review) {
      console.log("Could not parse JSON, posting plain summary");
      await upsertSummary({
        octokit,
        owner,
        repo,
        issue_number: pull_number,
        body: `**🤖 AI Review** (commit \`${sha.slice(0, 7)}\`)\n\n${raw}`,
      });
      return;
    }

    const comments = (review.comments || []).filter(
      (c) => valid[c.file] && valid[c.file].has(Number(c.line))
    );

    let posted = 0;
    for (const c of comments) {
      try {
        await octokit.rest.pulls.createReviewComment({
          owner,
          repo,
          pull_number,
          commit_id: sha,
          path: c.file,
          line: Number(c.line),
          side: "RIGHT",
          body: `${MARKER}\n${ICONS[c.severity] || "🟢"} **${c.severity || "suggestion"}:** ${c.comment}`,
        });
        posted++;
        await sleep(300); // GitHub ke rate limit se bachne ke liye
      } catch (err) {
        console.error(`Could not post comment on ${c.file}:${c.line} -> ${err.message}`);
      }
    }

    await upsertSummary({
      octokit,
      owner,
      repo,
      issue_number: pull_number,
      body:
        `**🤖 AI Review** (commit \`${sha.slice(0, 7)}\`)\n\n` +
        `${review.summary || ""}\n\n_${posted} inline comment(s) on this commit._`,
    });
    console.log(`Review posted! (${posted} inline comments)`);
  } catch (err) {
    reviewed.delete(key); // fail hua to dobara try karne do
    console.error("Review failed:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));