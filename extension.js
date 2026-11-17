// Local OpenAI-compatible gateway (/v1/models, /v1/chat/completions) over vscode.lm.
const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const TOKEN_FILE = path.join(os.homedir(), '.copilot-lm-gateway', 'token');
const JUSTIFICATION = 'Copilot LM Gateway serves local OpenAI-compatible requests (e.g. TradingAgents).';

let server;
let log;

class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function loadOrCreateToken() {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  if (fs.existsSync(TOKEN_FILE)) {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

function isAuthorized(req, token) {
  const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p && p.type === 'text' ? p.text : '')).join('');
  }
  return String(content);
}

async function copilotModels() {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  const seen = new Set();
  return models.filter((m) => !seen.has(m.id) && seen.add(m.id));
}

// Consecutive same-role messages are merged: Anthropic models need strict user/assistant alternation,
// and parallel tool results must sit in one user turn.
function toLmMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new HttpError(400, '`messages` must be a non-empty array');
  const turns = [];
  const add = (role, parts) => {
    if (parts.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else turns.push({ role, parts });
  };
  const textParts = (content) => {
    const text = textOf(content);
    return text ? [new vscode.LanguageModelTextPart(text)] : [];
  };

  for (const m of messages) {
    switch (m.role) {
      case 'system':
      case 'developer':
      case 'user':
        // The stable LM API has no system role, so system prompts travel as user text.
        add('user', textParts(m.content));
        break;
      case 'assistant': {
        const parts = textParts(m.content);
        for (const tc of m.tool_calls || []) {
          let input;
          try {
            input = JSON.parse(tc.function.arguments || '{}');
          } catch {
            throw new HttpError(400, `Tool call ${tc.id} has invalid JSON arguments`);
          }
          parts.push(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, input));
        }
        add('assistant', parts);
        break;
      }
      case 'tool':
        add('user', [
          new vscode.LanguageModelToolResultPart(m.tool_call_id, [new vscode.LanguageModelTextPart(textOf(m.content) || '(empty)')]),
        ]);
        break;
      default:
        throw new HttpError(400, `Unsupported message role: ${m.role}`);
    }
  }
  return turns.map((t) =>
    t.role === 'user' ? vscode.LanguageModelChatMessage.User(t.parts) : vscode.LanguageModelChatMessage.Assistant(t.parts)
  );
}

function toLmOptions(body) {
  const options = { justification: JUSTIFICATION };
  // Copilot drops an effort the model doesn't support, so a wrong value falls back to the model default.
  const effort = body.reasoning_effort || vscode.workspace.getConfiguration('copilotGateway').get('reasoningEffort');
  if (effort) options.configuration = { reasoningEffort: effort };
  const choice = body.tool_choice;
  let tools = (body.tools || []).filter((t) => t.type === 'function' && t.function);
  if (choice === 'none') tools = [];
  if (choice && typeof choice === 'object' && choice.function) {
    tools = tools.filter((t) => t.function.name === choice.function.name);
  }
  if (tools.length) {
    options.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      inputSchema: t.function.parameters || { type: 'object', properties: {} },
    }));
    const required = choice === 'required' || (choice && typeof choice === 'object');
    options.toolMode = required ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto;
  }
  return options;
}

function mapLmError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof vscode.LanguageModelError) {
    if (err.code === vscode.LanguageModelError.NoPermissions().code) {
      return new HttpError(403, 'No permission to use Copilot models. Run "Copilot LM Gateway: Test" in VS Code and click Allow.', 'permission_error');
    }
    if (err.code === vscode.LanguageModelError.Blocked().code) {
      return new HttpError(429, `Copilot blocked the request (quota or rate limit): ${err.message}`, 'rate_limit_error');
    }
    if (err.code === vscode.LanguageModelError.NotFound().code) {
      return new HttpError(404, err.message, 'not_found_error');
    }
  }
  return new HttpError(502, `Copilot request failed: ${err && err.message ? err.message : String(err)}`, 'api_error');
}

async function chatCompletions(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(400, 'Body is not valid JSON');
  }
  if (body.stream) throw new HttpError(400, 'stream=true is not supported by this gateway');

  const models = await copilotModels();
  const model = models.find((m) => m.id === body.model) || models.find((m) => m.family === body.model);
  if (!model) {
    throw new HttpError(404, `Model '${body.model}' not available. Known: ${models.map((m) => m.id).join(', ')}`, 'not_found_error');
  }

  const messages = toLmMessages(body.messages);
  const options = toLmOptions(body);
  const cts = new vscode.CancellationTokenSource();
  res.on('close', () => {
    if (!res.writableEnded) cts.cancel();
  });

  let text = '';
  const toolCalls = [];
  try {
    const response = await model.sendRequest(messages, options, cts.token);
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
        });
      }
    }
  } catch (err) {
    throw mapLmError(err);
  } finally {
    cts.dispose();
  }

  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (toolCalls.length) message.tool_calls = toolCalls;
  sendJson(res, 200, {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  return model.id;
}

async function listModels(res) {
  const models = await copilotModels();
  sendJson(res, 200, {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      owned_by: m.vendor,
      name: m.name,
      family: m.family,
      max_input_tokens: m.maxInputTokens,
    })),
  });
}

function startServer(token, port) {
  server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = (req.url || '').split('?')[0];
    let modelId = '';
    try {
      if (!isAuthorized(req, token)) throw new HttpError(401, 'Missing or invalid bearer token', 'authentication_error');
      if (req.method === 'GET' && url === '/v1/models') await listModels(res);
      else if (req.method === 'POST' && url === '/v1/chat/completions') modelId = await chatCompletions(req, res);
      else throw new HttpError(404, `No route for ${req.method} ${url}`, 'not_found_error');
    } catch (err) {
      const e = err instanceof HttpError ? err : mapLmError(err);
      if (!res.headersSent) sendJson(res, e.status, { error: { message: e.message, type: e.type } });
      log.appendLine(`ERROR ${req.method} ${url}: ${e.status} ${e.message}`);
    }
    // Content is never logged; only metadata.
    log.appendLine(`${new Date().toISOString()} ${req.method} ${url} ${res.statusCode} ${modelId} ${Date.now() - started}ms`);
  });
  server.on('error', (err) => {
    log.appendLine(`Server error: ${err.message}`);
    vscode.window.showErrorMessage(`Copilot LM Gateway could not listen on 127.0.0.1:${port}: ${err.message}`);
  });
  server.listen(port, '127.0.0.1', () => log.appendLine(`Listening on http://127.0.0.1:${port}/v1 (token file: ${TOKEN_FILE})`));
}

function activate(context) {
  log = vscode.window.createOutputChannel('Copilot LM Gateway');
  context.subscriptions.push(log);

  const port = vscode.workspace.getConfiguration('copilotGateway').get('port', 8787);
  startServer(loadOrCreateToken(), port);
  context.subscriptions.push({ dispose: () => server && server.close() });

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotGateway.test', async () => {
      try {
        const models = await copilotModels();
        if (!models.length) throw new Error('No Copilot chat models found. Is Copilot signed in?');
        const model = models[0];
        const response = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User('Reply with the single word: pong')],
          { justification: JUSTIFICATION }
        );
        let reply = '';
        for await (const chunk of response.text) reply += chunk;
        log.appendLine(`Models: ${models.map((m) => m.id).join(', ')}`);
        vscode.window.showInformationMessage(`Copilot LM Gateway OK (${model.id}): ${reply.trim()}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Copilot LM Gateway test failed: ${err.message}`);
      }
    })
  );
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate };
