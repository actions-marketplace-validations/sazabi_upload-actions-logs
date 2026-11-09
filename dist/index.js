// src/records.ts
var SEVERITY = {
  INFO: { number: 9, text: "INFO" },
  WARN: { number: 13, text: "WARN" },
  ERROR: { number: 17, text: "ERROR" }
};
var NANOS_PER_MILLI = 1000000n;
var isoToUnixNano = (iso) => BigInt(Date.parse(iso)) * NANOS_PER_MILLI;
var durationMs = ({
  from,
  to
}) => {
  if (!from || !to)
    return;
  const value = Date.parse(to) - Date.parse(from);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};
var RESULTS = {
  success: "success",
  failure: "failure",
  cancelled: "cancellation",
  skipped: "skip",
  timed_out: "timeout",
  startup_failure: "error"
};
var resultOf = (conclusion) => conclusion ? RESULTS[conclusion] : undefined;
var WARN_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "startup_failure",
  "action_required"
]);
var severityOf = (conclusion) => conclusion && WARN_CONCLUSIONS.has(conclusion) ? SEVERITY.WARN : SEVERITY.INFO;
var compact = (attributes) => {
  const result = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === "")
      continue;
    if (Array.isArray(value) && value.length === 0)
      continue;
    result[key] = value;
  }
  return result;
};
var resourceAttributes = (run, serviceName) => {
  const pullRequest = run.pull_requests?.[0]?.number;
  return compact({
    "service.name": serviceName ?? run.repository.name,
    "vcs.provider.name": "github",
    "vcs.owner.name": run.repository.owner.login,
    "vcs.repository.name": run.repository.name,
    "vcs.repository.url.full": run.repository.html_url,
    "vcs.ref.head.name": run.head_branch,
    "vcs.ref.head.revision": run.head_sha,
    "vcs.change.id": pullRequest === undefined ? undefined : String(pullRequest),
    "cicd.pipeline.name": run.name,
    "cicd.pipeline.run.id": String(run.id),
    "cicd.pipeline.run.url.full": run.html_url,
    "github.run.attempt": run.run_attempt,
    "github.event_name": run.event,
    "github.actor": run.actor?.login
  });
};
var runKey = (run) => `${run.id}-${run.run_attempt}`;
var runSummary = (run, jobCount) => ({
  timeUnixNano: isoToUnixNano(run.updated_at),
  severity: severityOf(run.conclusion),
  body: `Workflow run ${run.name ?? run.path} #${run.id} attempt ${run.run_attempt} completed: ${run.conclusion ?? "unknown"}`,
  attributes: compact({
    "event.name": "github.actions.run",
    "log.record.uid": runKey(run),
    "cicd.pipeline.result": resultOf(run.conclusion),
    "github.conclusion": run.conclusion,
    "github.duration_ms": durationMs({
      from: run.run_started_at ?? run.created_at,
      to: run.updated_at
    }),
    "github.queue_duration_ms": durationMs({
      from: run.created_at,
      to: run.run_started_at
    }),
    "github.job_count": jobCount
  })
});
var jobAttributes = (job) => compact({
  "cicd.pipeline.task.name": job.name,
  "cicd.pipeline.task.run.id": String(job.id),
  "cicd.pipeline.task.run.url.full": job.html_url,
  "cicd.worker.name": job.runner_name,
  "cicd.worker.id": job.runner_id === null || job.runner_id === 0 ? undefined : String(job.runner_id),
  "github.runner.group": job.runner_group_name,
  "github.runner.labels": job.labels
});
var jobKey = (run, job) => `${runKey(run)}-${job.id}`;
var jobSummary = (run, job) => ({
  timeUnixNano: isoToUnixNano(job.completed_at ?? job.started_at ?? run.updated_at),
  severity: severityOf(job.conclusion),
  body: `Job ${job.name} completed: ${job.conclusion ?? "unknown"}`,
  attributes: compact({
    ...jobAttributes(job),
    "event.name": "github.actions.job",
    "log.record.uid": jobKey(run, job),
    "cicd.pipeline.task.run.result": resultOf(job.conclusion),
    "github.conclusion": job.conclusion,
    "github.duration_ms": durationMs({
      from: job.started_at,
      to: job.completed_at
    }),
    "github.queue_duration_ms": durationMs({
      from: job.created_at,
      to: job.started_at
    })
  })
});
var stepSummary = (run, job, step) => ({
  timeUnixNano: isoToUnixNano(step.completed_at ?? step.started_at ?? job.completed_at ?? run.updated_at),
  severity: severityOf(step.conclusion),
  body: `Step ${step.number} ${step.name} completed: ${step.conclusion ?? "unknown"}`,
  attributes: compact({
    ...jobAttributes(job),
    "event.name": "github.actions.step",
    "log.record.uid": `${jobKey(run, job)}-s${step.number}`,
    "github.step.name": step.name,
    "github.step.number": step.number,
    "github.conclusion": step.conclusion,
    "github.duration_ms": durationMs({
      from: step.started_at,
      to: step.completed_at
    })
  })
});

// src/job-log.ts
var NEWLINE = 10;
var NANOS_PER_SECOND = 1000000000n;
var countNewlines = (buffer) => {
  let count = 0;
  for (let index = buffer.indexOf(NEWLINE);index !== -1; index = buffer.indexOf(NEWLINE, index + 1)) {
    count += 1;
  }
  return count;
};

class LogCapper {
  #maxBytes;
  #headBudget;
  #head = [];
  #headBytes = 0;
  #window = [];
  #windowBytes = 0;
  #totalBytes = 0;
  #totalNewlines = 0;
  constructor(maxBytes) {
    this.#maxBytes = maxBytes;
    this.#headBudget = Math.floor(maxBytes / 10);
  }
  push(chunk) {
    if (chunk.length === 0)
      return;
    this.#totalBytes += chunk.length;
    this.#totalNewlines += countNewlines(chunk);
    if (this.#headBytes < this.#headBudget) {
      const part = chunk.subarray(0, this.#headBudget - this.#headBytes);
      this.#head.push(part);
      this.#headBytes += part.length;
    }
    this.#window.push(chunk);
    this.#windowBytes += chunk.length;
    while (this.#window.length > 1 && this.#windowBytes - (this.#window[0]?.length ?? 0) >= this.#maxBytes) {
      this.#windowBytes -= this.#window.shift()?.length ?? 0;
    }
  }
  finish() {
    const window = Buffer.concat(this.#window);
    if (this.#totalBytes <= this.#maxBytes) {
      return {
        head: window,
        tail: Buffer.alloc(0),
        tailFirstLine: 0,
        omittedBytes: 0
      };
    }
    const head = Buffer.concat(this.#head);
    const lastHeadNewline = head.lastIndexOf(NEWLINE, this.#headBudget - 1);
    const headEnd = lastHeadNewline === -1 ? 0 : lastHeadNewline + 1;
    const tailBudget = this.#maxBytes - this.#headBudget;
    const tailSearch = window.length - tailBudget;
    const firstTailNewline = window.indexOf(NEWLINE, Math.max(tailSearch - 1, 0));
    const tailStart = firstTailNewline === -1 ? window.length : firstTailNewline + 1;
    const tail = window.subarray(tailStart);
    const windowOffset = this.#totalBytes - window.length;
    return {
      head: head.subarray(0, headEnd),
      tail,
      tailFirstLine: this.#totalNewlines - countNewlines(tail) + 1,
      omittedBytes: windowOffset + tailStart - headEnd
    };
  }
}
var TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z ?/;
var parseLine = (raw) => {
  const match = TIMESTAMP.exec(raw);
  if (!match?.[1])
    return { timeUnixNano: undefined, text: raw };
  const seconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(seconds))
    return { timeUnixNano: undefined, text: raw };
  const fraction = BigInt((match[2] ?? "").padEnd(9, "0"));
  return {
    timeUnixNano: BigInt(seconds) * 1000000n + fraction,
    text: raw.slice(match[0].length)
  };
};
var severityOfLine = (text) => {
  if (text.startsWith("##[error]"))
    return SEVERITY.ERROR;
  if (text.startsWith("##[warning]"))
    return SEVERITY.WARN;
  return SEVERITY.INFO;
};
var STEP_HEADER = /^##\[group\]Run |^Post job cleanup\.$/;
var headerNamesStep = (text, name) => {
  if (!text.startsWith("##[group]Run "))
    return false;
  const header = text.slice("##[group]".length).trim();
  const stepName = name.replace(/\s*\\$/, "").trim();
  return stepName.startsWith("Run ") && header.startsWith(stepName);
};
var secondOf = (unixNano) => unixNano / NANOS_PER_SECOND;

class StepAttributor {
  #steps;
  #current = 0;
  #nestedActions = 0;
  constructor(steps) {
    this.#steps = (steps ?? []).filter((step) => step.started_at !== null && step.conclusion !== "skipped").map((step) => ({
      step,
      startSecond: secondOf(isoToUnixNano(step.started_at)),
      endSecond: secondOf(isoToUnixNano(step.completed_at ?? step.started_at))
    })).sort((a, b) => a.step.number - b.step.number);
  }
  skipGap() {
    this.#nestedActions = 0;
  }
  stepFor(timeUnixNano, text) {
    const second = secondOf(timeUnixNano);
    const candidates = [];
    this.#steps.forEach((timed, index) => {
      if (timed.startSecond <= second && second <= timed.endSecond) {
        candidates.push(index);
      }
    });
    if (candidates.length === 0)
      return;
    const later = candidates.filter((index) => index >= this.#current);
    if (later.length === 0) {
      return this.#steps[candidates[candidates.length - 1] ?? 0]?.step;
    }
    let chosen = later[0] ?? 0;
    if (text.startsWith("##[start-action "))
      this.#nestedActions += 1;
    if (text.startsWith("##[end-action ")) {
      this.#nestedActions = Math.max(this.#nestedActions - 1, 0);
    }
    if (this.#nestedActions === 0 && STEP_HEADER.test(text)) {
      const named = later.find((index) => headerNamesStep(text, this.#steps[index]?.step.name ?? ""));
      const next = later.find((index) => index > this.#current);
      if (named !== undefined) {
        chosen = named;
      } else if (chosen === this.#current && next !== undefined) {
        chosen = next;
      }
    }
    this.#current = chosen;
    return this.#steps[chosen]?.step;
  }
}
var splitLines = (chunk) => {
  if (chunk.length === 0)
    return [];
  const lines = chunk.toString("utf8").split(`
`);
  if (lines[lines.length - 1] === "")
    lines.pop();
  return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
};
function* jobLogRecords(input) {
  const { run, job, capped } = input;
  const attributor = new StepAttributor(job.steps);
  const baseAttributes = jobAttributes(job);
  const key = jobKey(run, job);
  let lastTime = isoToUnixNano(job.started_at ?? run.updated_at);
  function* lines(chunk, firstLine) {
    let lineNumber = firstLine;
    for (const raw of splitLines(chunk)) {
      const parsed = parseLine(lineNumber === 1 ? raw.replace(/^\uFEFF/, "") : raw);
      const time = parsed.timeUnixNano ?? lastTime;
      lastTime = time;
      const step = attributor.stepFor(time, parsed.text);
      yield {
        timeUnixNano: time,
        severity: severityOfLine(parsed.text),
        body: parsed.text,
        attributes: {
          ...baseAttributes,
          ...step ? {
            "github.step.name": step.name,
            "github.step.number": step.number
          } : {},
          "github.log.line": lineNumber,
          "log.record.uid": `${key}-l${lineNumber}`
        }
      };
      lineNumber += 1;
    }
  }
  yield* lines(capped.head, 1);
  if (capped.omittedBytes > 0) {
    yield {
      timeUnixNano: lastTime,
      severity: SEVERITY.WARN,
      body: `${capped.omittedBytes} bytes of this job's log were left out (max-bytes-per-job is ${input.maxBytes})`,
      attributes: {
        ...baseAttributes,
        "github.log.truncated": true,
        "github.log.omitted_bytes": capped.omittedBytes,
        "log.record.uid": `${key}-truncated`
      }
    };
    attributor.skipGap();
    yield* lines(capped.tail, capped.tailFirstLine);
  }
}

// src/github.ts
var API_VERSION = "2022-11-28";
var USER_AGENT = "sazabi-upload-actions-logs";
var API_TIMEOUT_MS = 30000;
var LOG_TIMEOUT_MS = 120000;
var MAX_ATTEMPTS = 4;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GitHubClient {
  #apiUrl;
  #token;
  #owner;
  #repo;
  constructor(input) {
    const [owner, repo, ...rest] = input.repository.split("/");
    if (!owner || !repo || rest.length > 0) {
      throw new Error(`Invalid repository: ${input.repository}`);
    }
    this.#apiUrl = input.apiUrl.replace(/\/+$/, "");
    this.#token = input.token;
    this.#owner = owner;
    this.#repo = repo;
  }
  #repoUrl(path) {
    return `${this.#apiUrl}/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}${path}`;
  }
  async#get(url, input) {
    for (let attempt = 1;; attempt += 1) {
      try {
        const response = await this.#fetch(url, input.timeoutMs);
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          return await input.read(response);
        }
        await response.body?.cancel();
      } catch (cause) {
        if (cause instanceof GitHubResponseError || attempt >= MAX_ATTEMPTS) {
          throw cause;
        }
      }
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  #fetch(url, timeoutMs) {
    return fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION
      },
      redirect: "follow"
    });
  }
  async listJobs(input) {
    const jobs = [];
    for (let page = 1;; page += 1) {
      const body = await this.#get(this.#repoUrl(`/actions/runs/${input.runId}/attempts/${input.attempt}/jobs?per_page=100&page=${page}`), {
        timeoutMs: API_TIMEOUT_MS,
        read: async (response) => {
          if (!response.ok) {
            throw new GitHubResponseError(`Listing the run's jobs failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
          }
          return await response.json();
        }
      });
      jobs.push(...body.jobs);
      if (body.jobs.length < 100 || jobs.length >= body.total_count) {
        return jobs;
      }
    }
  }
  async downloadJobLog(input) {
    const url = this.#repoUrl(`/actions/jobs/${input.jobId}/logs`);
    for (let attempt = 0;; attempt += 1) {
      const result = await this.#get(url, {
        timeoutMs: LOG_TIMEOUT_MS,
        read: async (response) => {
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            return response.status;
          }
          const capper = new LogCapper(input.maxBytes);
          for await (const chunk of response.body) {
            capper.push(Buffer.from(chunk));
          }
          return capper.finish();
        }
      });
      if (typeof result !== "number")
        return result;
      if (result === 404 && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (result === 404 || result === 410)
        return null;
      throw new GitHubResponseError(`Downloading the log of job ${input.jobId} failed (${result})`);
    }
  }
}

class GitHubResponseError extends Error {
}

// src/inputs.ts
import { readFileSync } from "node:fs";
var readInput = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
var readBoolean = (name, fallback) => {
  const value = readInput(name).toLowerCase();
  if (value === "")
    return fallback;
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  throw new Error(`Input ${name} must be true or false, got "${value}"`);
};
var DEFAULT_MAX_BYTES_PER_JOB = 10 * 1024 * 1024;
var readInputs = () => {
  const url = readInput("url");
  if (!url) {
    throw new Error("Input url is empty. Pass the log source's intake URL from a secret, such as SAZABI_LOGS_URL");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Input url is not a valid URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
    throw new Error("Input url must be an https URL");
  }
  const maxBytesRaw = readInput("max-bytes-per-job");
  const maxBytesPerJob = maxBytesRaw === "" ? DEFAULT_MAX_BYTES_PER_JOB : Number(maxBytesRaw);
  if (!Number.isSafeInteger(maxBytesPerJob) || maxBytesPerJob < 1024) {
    throw new Error(`Input max-bytes-per-job must be a whole number of bytes, at least 1024, got "${maxBytesRaw}"`);
  }
  const githubToken = readInput("github-token");
  if (!githubToken) {
    throw new Error("Input github-token is empty");
  }
  return {
    url,
    logs: readBoolean("logs", true),
    maxBytesPerJob,
    serviceName: readInput("service-name") || undefined,
    failOnError: readBoolean("fail-on-error", false),
    githubToken
  };
};
var readTriggeringRun = () => {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  if (eventName !== "workflow_run") {
    return {
      kind: "skip",
      reason: `This action runs on the workflow_run event; this run was triggered by ${eventName || "an unknown event"}, so nothing was sent`
    };
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath)
    throw new Error("GITHUB_EVENT_PATH is not set");
  const payload = JSON.parse(readFileSync(eventPath, "utf8"));
  const run = payload.workflow_run;
  if (!run)
    throw new Error("The workflow_run event has no workflow_run");
  if (isThisWorkflow(run)) {
    return {
      kind: "skip",
      reason: `The triggering run is this workflow (${run.path}); add "!${run.name ?? "this workflow"}" to its workflows list. Nothing was sent`
    };
  }
  return { kind: "run", run };
};
var isThisWorkflow = (run) => {
  const ref = process.env.GITHUB_WORKFLOW_REF ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (ref.startsWith(`${repository}/`)) {
    const path = ref.slice(repository.length + 1).split("@")[0];
    return path === run.path;
  }
  return run.name !== null && run.name === process.env.GITHUB_WORKFLOW;
};

// src/otlp.ts
import { gzipSync } from "node:zlib";
var BATCH_BYTES = 5 * 1024 * 1024;
var MAX_ATTEMPTS2 = 4;
var UPLOAD_TIMEOUT_MS = 60000;
var INTAKE_WINDOW_MS = 23 * 60 * 60 * 1000;
var SCOPE_NAME = "sazabi/upload-actions-logs";
var encodeValue = (value) => {
  if (typeof value === "string")
    return { stringValue: value };
  if (typeof value === "boolean")
    return { boolValue: value };
  if (typeof value === "number")
    return { intValue: String(value) };
  return {
    arrayValue: { values: value.map((item) => ({ stringValue: item })) }
  };
};
var encodeAttributes = (attributes) => Object.entries(attributes).map(([key, value]) => ({
  key,
  value: encodeValue(value)
}));
var sleep2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class OtlpLogSender {
  #url;
  #resource;
  #uploadTimeUnixNano;
  #oldestAcceptedUnixNano;
  #pending = [];
  #pendingBytes = 0;
  stats = { sent: 0, rejected: 0, requests: 0, retimed: 0 };
  constructor(input) {
    this.#url = input.url;
    this.#resource = encodeAttributes(input.resource);
    const now = input.now ?? Date.now();
    this.#uploadTimeUnixNano = BigInt(now) * 1000000n;
    this.#oldestAcceptedUnixNano = BigInt(now - INTAKE_WINDOW_MS) * 1000000n;
  }
  async add(record) {
    let time = record.timeUnixNano;
    let attributes = record.attributes;
    if (time < this.#oldestAcceptedUnixNano) {
      attributes = {
        ...attributes,
        "github.original_time": new Date(Number(time / 1000000n)).toISOString()
      };
      time = this.#uploadTimeUnixNano;
      this.stats.retimed += 1;
    }
    const encoded = JSON.stringify({
      timeUnixNano: String(time),
      observedTimeUnixNano: String(this.#uploadTimeUnixNano),
      severityNumber: record.severity.number,
      severityText: record.severity.text,
      body: { stringValue: record.body },
      attributes: encodeAttributes(attributes)
    });
    this.#pending.push(encoded);
    this.#pendingBytes += encoded.length + 1;
    if (this.#pendingBytes >= BATCH_BYTES)
      await this.flush();
  }
  async flush() {
    if (this.#pending.length === 0)
      return;
    const records = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;
    const payload = `{"resourceLogs":[{"resource":{"attributes":${JSON.stringify(this.#resource)}},"scopeLogs":[{"scope":{"name":"${SCOPE_NAME}"},"logRecords":[${records.join(",")}]}]}]}`;
    const body = gzipSync(payload);
    const rejected = await this.#post(body);
    this.stats.requests += 1;
    this.stats.sent += records.length;
    this.stats.rejected += rejected;
  }
  async#post(body) {
    for (let attempt = 1;; attempt += 1) {
      let status;
      let text;
      let retryAfterMs;
      try {
        const response = await fetch(this.#url, {
          method: "POST",
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip"
          },
          body: new Uint8Array(body)
        });
        status = response.status;
        text = await response.text();
        retryAfterMs = retryDelayMs({ response, attempt });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS2) {
          throw new Error(`Sending to Sazabi failed after ${attempt} attempts: ${describeNetworkError(error)}`);
        }
        await sleep2(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (status >= 200 && status < 300)
        return rejectedCount(text);
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS2) {
        const detail = text.slice(0, 300);
        throw new Error(`Sazabi rejected the upload (${status})${detail ? `: ${detail}` : ""}`);
      }
      await sleep2(retryAfterMs);
    }
  }
}
var retryDelayMs = ({
  response,
  attempt
}) => {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter, 30) * 1000;
  }
  return 1000 * 2 ** (attempt - 1);
};
var rejectedCount = (text) => {
  if (!text)
    return 0;
  try {
    const parsed = JSON.parse(text);
    const value = Number(parsed.partialSuccess?.rejectedLogRecords ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};
var describeNetworkError = (error) => {
  const cause = error?.cause;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  if (typeof code === "string")
    return code;
  return error instanceof Error ? error.name : "network error";
};

// src/workflow-commands.ts
var escapeData = (value) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll(`
`, "%0A");
var info = (message) => {
  process.stdout.write(`${message}
`);
};
var warning = (message) => {
  process.stdout.write(`::warning::${escapeData(message)}
`);
};
var error = (message) => {
  process.stdout.write(`::error::${escapeData(message)}
`);
};
var mask = (value) => {
  if (value)
    process.stdout.write(`::add-mask::${escapeData(value)}
`);
};

// src/main.ts
var LOG_PREFETCH = 4;
var hasLog = (job) => Boolean(job.runner_name) && job.conclusion !== "skipped";
var run = async () => {
  const inputs = readInputs();
  mask(inputs.url);
  mask(new URL(inputs.url).host);
  const event = readTriggeringRun();
  if (event.kind === "skip") {
    warning(event.reason);
    return;
  }
  const workflowRun = event.run;
  const github = new GitHubClient({
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    token: inputs.githubToken,
    repository: process.env.GITHUB_REPOSITORY ?? workflowRun.repository.full_name
  });
  const jobs = await github.listJobs({
    runId: workflowRun.id,
    attempt: workflowRun.run_attempt
  });
  const sender = new OtlpLogSender({
    url: inputs.url,
    resource: resourceAttributes(workflowRun, inputs.serviceName)
  });
  await sender.add(runSummary(workflowRun, jobs.length));
  const downloads = new Map;
  const download = (index) => {
    const job = jobs[index];
    if (!job || downloads.has(index) || !inputs.logs || !hasLog(job))
      return;
    const pending = github.downloadJobLog({
      jobId: job.id,
      maxBytes: inputs.maxBytesPerJob
    });
    pending.catch(() => {
      return;
    });
    downloads.set(index, pending);
  };
  let lines = 0;
  const missingLogs = [];
  const failedDownloads = [];
  for (const [index, job] of jobs.entries()) {
    for (let ahead = index;ahead < index + LOG_PREFETCH; ahead += 1) {
      download(ahead);
    }
    await sender.add(jobSummary(workflowRun, job));
    for (const step of job.steps ?? []) {
      await sender.add(stepSummary(workflowRun, job, step));
    }
    const pending = downloads.get(index);
    if (!pending)
      continue;
    downloads.delete(index);
    let log;
    try {
      log = await pending;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      failedDownloads.push(`${job.name}: ${message}`);
      warning(`${message}; sent its summaries only`);
      continue;
    }
    if (log === null) {
      missingLogs.push(job.name);
      continue;
    }
    for (const record of jobLogRecords({
      run: workflowRun,
      job,
      capped: log,
      maxBytes: inputs.maxBytesPerJob
    })) {
      await sender.add(record);
      lines += 1;
    }
  }
  await sender.flush();
  const { stats } = sender;
  if (missingLogs.length > 0) {
    warning(`GitHub had no log for ${missingLogs.length} job(s) (${missingLogs.join(", ")}); sent their summaries only`);
  }
  if (stats.retimed > 0) {
    warning(`${stats.retimed} record(s) were older than the intake accepts; they carry the upload time and their real time in github.original_time`);
  }
  if (stats.rejected > 0) {
    warning(`Sazabi did not keep ${stats.rejected} of ${stats.sent} record(s)`);
  }
  info(`Sent ${stats.sent} record(s) for ${workflowRun.name ?? workflowRun.path} run ${workflowRun.id} attempt ${workflowRun.run_attempt}: ${jobs.length} job(s), ${lines} log line(s), in ${stats.requests} request(s)`);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(outputPath, `records=${stats.sent}
`);
  }
  if (inputs.failOnError && failedDownloads.length > 0) {
    throw new Error(`${failedDownloads.length} job log(s) could not be downloaded (${failedDownloads.join("; ")})`);
  }
};
var failOnError = (() => {
  const value = (process.env["INPUT_FAIL-ON-ERROR"] ?? "").trim();
  return value.toLowerCase() === "true";
})();
run().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (failOnError) {
    error(`Uploading this run's logs to Sazabi failed: ${message}`);
    process.exitCode = 1;
    return;
  }
  warning(`Uploading this run's logs to Sazabi failed: ${message}. This job still succeeds; set fail-on-error: true to fail it instead`);
});
