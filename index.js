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

const ICONS = { critical: "#", warning: "##", suggestion: "###" };

// ---------- Webhook ----------
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

    const { text, valid } = annotateDiff(String(diff));
    const raw = await reviewDiff(text);
    const review = parseReview(raw);

    // JSON parse nahi hua to purana tareeka: ek bada comment
    if (!review) {
      console.log("Could not parse JSON, posting plain comment");
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pull_number,
        body: "** AI Review**\n\n" + raw,
      });
      return;
    }

    // Sirf wahi comments rakho jinki file + line diff mein hai
    const comments = (review.comments || [])
      .filter((c) => valid[c.file] && valid[c.file].has(Number(c.line)))
      .map((c) => ({
        path: c.file,
        line: Number(c.line),
        side: "RIGHT",
        body: `${ICONS[c.severity] || "#"} **${c.severity || "suggestion"}:** ${c.comment}`,
      }));

    console.log(`Posting review with ${comments.length} inline comments`);

    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number,
        event: "COMMENT",
        body: `** AI Review**\n\n${review.summary || ""}`,
        comments,
      });
    } catch (err) {
      console.error("Inline review failed, falling back:", err.message);
      const lines = (review.comments || []).map(
        (c) => `- ${ICONS[c.severity] || "#"} \`${c.file}:${c.line}\` ${c.comment}`
      );
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pull_number,
        body: `** AI Review**\n\n${review.summary || ""}\n\n${lines.join("\n")}`,
      });
    }
    console.log("Review posted!");
  } catch (err) {
    console.error("Review failed:", err.message);
  }
});

app.listen(3000, () => console.log("Running on http://localhost:3000"));