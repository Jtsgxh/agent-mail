// Claude Channel 与 Codex MCP 共用主题工具定义，保持收发协议一致。
export const topicTools = [
  {
    name: "mailbox_topic",
    description:
      "Get the current topic metadata and discussion goal before reading or replying.",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "mailbox_read",
    description:
      "Read a topic in message-ID order; follow next while hasMore is true.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        after: { type: "integer", minimum: 0 },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "mailbox_ack",
    description:
      "Confirm that you have read messages in this topic through a message ID.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        through: { type: "integer", minimum: 1 },
      },
      required: ["topic", "through"],
      additionalProperties: false,
    },
  },
  {
    name: "mailbox_reply",
    description:
      "Reply to a message. Set notify only when requesting a further response.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        message: { type: "integer", minimum: 1 },
        body: { type: "string" },
        notify: { type: "boolean" },
        requestId: { type: "string" },
      },
      required: ["topic", "message", "body"],
      additionalProperties: false,
    },
  },
];

// 按同一参与者执行主题读取、回复与实际已读确认。
export async function callTopicTool(client, as, params) {
  const a = params.arguments ?? {};
  if (typeof a.topic !== "string" || !a.topic)
    throw new Error("topic is required");
  const path = `/api/topics/${encodeURIComponent(a.topic)}`;
  let result;
  if (params.name === "mailbox_topic")
    result = await client.request(path);
  else if (params.name === "mailbox_read")
    result = await client.request(`${path}/messages?after=${a.after ?? 0}`);
  else if (params.name === "mailbox_ack")
    result = await client.request(`${path}/ack`, {
      as,
      through: a.through,
    });
  else if (params.name === "mailbox_reply") {
    if (
      !Number.isSafeInteger(a.message) ||
      a.message < 1 ||
      (a.notify !== undefined && typeof a.notify !== "boolean")
    )
      throw new Error("Invalid message or notify");
    const page = await client.request(
      `${path}/messages?after=${a.message - 1}&limit=1`,
    );
    const original = page.messages[0];
    if (!original || original.id !== a.message)
      throw new Error("Reply target not found in this topic");
    result = await client.request(`${path}/messages`, {
      as,
      body: a.body,
      replyTo: a.message,
      to: a.notify ? original.author_id : null,
      requestId: a.requestId ?? `claude-reply-${a.message}`,
    });
  } else throw new Error(`Unknown tool: ${params.name}`);
  return result;
}
