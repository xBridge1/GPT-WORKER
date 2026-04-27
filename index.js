require('dotenv').config();
const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const server = http.createServer();
const wss = new WebSocket.Server({ server });
const userThreads = new Map();

server.listen(process.env.PORT || 8080, () => {
  console.log("Node rodando");
});

async function executarTool(name, args) {
  console.log("Tool call:", name, args);
  switch (name) {
    case "health": {
      const h = await fetch(process.env.API_ACOES_URL + "/health");
      return await h.json();
    }
    case "listar_agendamentos": {
      const lista = await fetch(
        process.env.API_ACOES_URL + `/acoes?limit=${args.limit || 100}&offset=${args.offset || 0}`,
        { headers: { "X-API-Token": process.env.API_TOKEN } }
      );
      return await lista.json();
    }
    case "obter_agendamento_ativo": {
      const ativo = await fetch(
        process.env.API_ACOES_URL + `/acoes/ativo?destino=${args.destino}&caller=${args.caller}`,
        { headers: { "X-API-Token": process.env.API_TOKEN } }
      );
      return await ativo.json();
    }
    case "criar_agendamento": {
      const novo = await fetch(process.env.API_ACOES_URL + "/acoes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Token": process.env.API_TOKEN,
        },
        body: JSON.stringify(args),
      });
      const resultado = await novo.json();
      console.log("Resposta API:", novo.status, JSON.stringify(resultado, null, 2));
      return resultado;
    }
    default:
      return { erro: "function nao encontrada" };
  }
}

async function rodarAssistant(userId, userMessage) {
  const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

  let threadId = userThreads.get(userId);
  if (!threadId) {
    const thread = await client.beta.threads.create();
    threadId = thread.id;
    userThreads.set(userId, threadId);
    console.log("Thread criada para usuário", userId, "→", threadId);
  } else {
    console.log("Reutilizando thread", threadId, "para usuário", userId);
  }

  await client.beta.threads.messages.create(threadId, {
    role: "user",
    content: userMessage,
  });

  let run = await client.beta.threads.runs.create(threadId, {
    assistant_id: ASSISTANT_ID,
  });
  console.log("Run criado:", run.id, "| Status:", run.status);

  while (["queued", "in_progress", "requires_action"].includes(run.status)) {
    await new Promise((r) => setTimeout(r, 1500));
    run = await client.beta.threads.runs.retrieve(run.id, { thread_id: threadId });
    console.log("Status atual:", run.status);

    if (run.status === "requires_action") {
      const toolCalls = run.required_action.submit_tool_outputs.tool_calls;
      const toolOutputs = await Promise.all(
        toolCalls.map(async (tc) => {
          const args = JSON.parse(tc.function.arguments);
          const resultado = await executarTool(tc.function.name, args);
          return { tool_call_id: tc.id, output: JSON.stringify(resultado) };
        })
      );
      await client.beta.threads.runs.submitToolOutputs(run.id, {
        thread_id: threadId,
        tool_outputs: toolOutputs,
      });
    }
  }

  if (run.status !== "completed") {
    throw new Error(`Run terminou com status: ${run.status}`);
  }

  const messages = await client.beta.threads.messages.list(threadId);
  const last = messages.data.find((m) => m.role === "assistant");
  return last.content[0].text.value;
}

wss.on("connection", (ws) => {
  console.log("Cliente conectado");

  ws.on("message", async (raw) => {
    const data = JSON.parse(raw);

    if (data.type !== "message" || !data.message) return;

    try {
      const resposta = await rodarAssistant(data.user_id, data.message);
      ws.send(JSON.stringify({ type: "response", message: resposta }));
    } catch (e) {
      console.error(e);
      ws.send(JSON.stringify({ message: "erro interno: " + e.message }));
    }
  });
});