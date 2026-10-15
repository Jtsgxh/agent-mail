import { z } from "zod";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const id = z.string().min(1).max(200);
const messageId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestId = z.string().min(1).max(160).describe("Reuse this ID when retrying the same message.");
const body = z.string().min(1).max(64000);

// Preserve synchronous store operations: project authorization and the entire
// reply read/write must finish in one turn. HTTP client adapters may return promises.
function then(value, next) {
  return value && typeof value.then === "function" ? value.then(next) : next(value);
}

// One catalog owns schemas, annotations and mail semantics for every transport.
const tools = {
  mailbox_identity: {
    description: "Get your authenticated participant, project and access mode.", readOnly: true,
    run: (m) => m.identity(),
  },
  mailbox_status: {
    description: "Inspect this connection's identity, subscription and wake status.", readOnly: true,
    run: (m) => m.status(),
  },
  mailbox_topics: {
    description: "List discussion topics available to this connection.", readOnly: true,
    run: (m) => m.topics(),
  },
  mailbox_create_topic: {
    description: "Create a discussion in your project and join as your bound participant.",
    shape: { title: z.string().min(1).max(160), goal: z.string().min(1).max(20000) },
    run: (m, a) => m.createTopic(a),
  },
  mailbox_topic: {
    description: "Get a topic's goal, status and participants before reading or replying.", readOnly: true,
    shape: { topic: id }, run: (m, a) => m.topic(a.topic),
  },
  mailbox_join: {
    description: "Join a topic as your bound participant.", idempotent: true,
    shape: { topic: id }, run: (m, a) => m.join(a.topic),
  },
  mailbox_read: {
    description: "Read topic history without marking it read. Follow next while hasMore is true.", readOnly: true,
    shape: { topic: id, after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(200).default(100) },
    run: (m, a) => m.read(a.topic, a.after, a.limit),
  },
  mailbox_inbox: {
    description: "Read pending directed messages and unread topic counts. Does not ACK.", readOnly: true,
    run: (m, a) => m.inbox(a.receipt),
  },
  mailbox_post: {
    description: "Post as your bound participant. Notify recipients only when requesting a response; reuse requestId on retry.", idempotent: true,
    shape: { topic: id, body, requestId, to: z.union([id, z.array(id).max(100)]).optional(), broadcast: z.boolean().default(false), replyTo: messageId.optional() },
    run: (m, { topic, ...a }) => m.post(topic, a),
  },
  mailbox_reply: {
    description: "Reply to a message in this topic. notify defaults to false; enable only when requesting a further answer.", idempotent: true,
    shape: { topic: id, message: messageId, body, requestId, notify: z.boolean().default(false) },
    run: (m, a) => then(m.read(a.topic, a.message - 1, 1), (page) => {
      const original = page.messages[0];
      if (!original || original.id !== a.message)
        throw Object.assign(new Error("Reply target not found in this topic"), { status: 400 });
      return m.post(a.topic, { body: a.body, requestId: a.requestId ?? `claude-reply-${a.message}`,
        replyTo: a.message, to: a.notify ? original.author_id : null });
    }),
  },
  mailbox_ack: {
    description: "Confirm messages through this ID only after processing them. Updates only your bound participant's progress.", idempotent: true,
    shape: { topic: id, through: messageId }, run: (m, a) => m.ack(a.topic, a.through),
  },
};

export const topicToolNames = ["mailbox_topic", "mailbox_read", "mailbox_ack", "mailbox_reply"];
export const codexToolNames = ["mailbox_status", "mailbox_topics", "mailbox_join", "mailbox_inbox", ...topicToolNames, "mailbox_post"];
export const connectorToolNames = Object.keys(tools).filter((name) => name !== "mailbox_status");

// Entry points supply identity/access policy and storage adapters, never tool dispatch.
export function installMailboxTools(server, {
  names, context, readOnly = false, wake = false, legacyReply = false,
  strict = true, structured = false, afterCall = () => {},
  formatError = (error) => error.message,
}) {
  const catalog = new Map(names.filter((name) => !readOnly || tools[name].readOnly).map((name) => {
    const tool = tools[name];
    const shape = { ...tool.shape };
    if (wake && name === "mailbox_inbox") shape.receipt = z.string().optional();
    // Claude Channel historically permits a deterministic reply ID when omitted.
    if (legacyReply && name === "mailbox_reply") shape.requestId = requestId.optional();
    const schema = strict ? z.object(shape).strict() : z.object(shape);
    const { $schema, ...inputSchema } = z.toJSONSchema(schema);
    const description = tool.description + (wake && name === "mailbox_join"
      ? " Enables automatic new-mail wakes for this Codex conversation."
      : wake && name === "mailbox_inbox" ? " Echo the receipt from a wake to allow the next wake." : "");
    return [name, { ...tool, schema, definition: { name, description, inputSchema,
      annotations: { readOnlyHint: !!tool.readOnly, destructiveHint: false,
        idempotentHint: !!(tool.idempotent || tool.readOnly), openWorldHint: !tool.readOnly } } }];
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...catalog.values()].map((tool) => tool.definition) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const tool = catalog.get(params.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { status: 400 });
      const parsed = tool.schema.safeParse(params.arguments ?? {});
      if (!parsed.success) throw Object.assign(new Error(parsed.error.message), { status: 400 });
      const result = await then(context(params, parsed.data, tool), (mailbox) =>
        then(tool.run(mailbox, parsed.data), (data) => { afterCall(data, tool); return data; }));
      return { content: [{ type: "text", text: JSON.stringify(result) }], ...(structured ? { structuredContent: result } : {}) };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: formatError(error) }] };
    }
  });
}
